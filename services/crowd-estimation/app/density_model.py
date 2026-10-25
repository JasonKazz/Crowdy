"""Reviewed ZIP-N inference architecture; no downloaded Python is executed.

Adapted from Yiming Ma's MIT-licensed ZIP implementation (2025):
https://github.com/Yiming-M/ZIP . See THIRD_PARTY_NOTICES.md.
Only the published NWPU ZIP-N MobileNetV4 checkpoint is supported.
"""

import torch
from torch import nn
from torch.nn import functional as F
from timm import create_model


class LighterRefine(nn.Module):
    def __init__(self, channels, output):
        super().__init__()
        self.conv1 = nn.Conv2d(channels, channels, 3, padding=1, groups=channels, bias=False)
        self.norm1, self.act1 = nn.BatchNorm2d(channels), nn.ReLU(inplace=True)
        self.conv2 = nn.Conv2d(channels, output, 1, bias=False)
        self.norm2, self.act2 = nn.BatchNorm2d(output), nn.ReLU(inplace=True)
        self.downsample = (nn.Sequential(nn.Conv2d(channels, output, 1, bias=False), nn.BatchNorm2d(output))
                           if channels != output else nn.Identity())

    def forward(self, x):
        out = self.act1(self.norm1(self.conv1(x)))
        return self.act2(self.norm2(self.conv2(out)) + self.downsample(x))


class Upsample(nn.Module):
    def __init__(self, channels):
        super().__init__()
        self.refine = LighterRefine(channels, channels)

    def forward(self, x):
        return self.refine(F.interpolate(x, scale_factor=2, mode="bilinear", align_corners=False))


class Backbone(nn.Module):
    def __init__(self):
        super().__init__()
        self.encoder = create_model("mobilenetv4_conv_small", pretrained=False, features_only=True, out_indices=[-1])
        self.refiner = Upsample(960)
        self.decoder = nn.Sequential(LighterRefine(960, 480), LighterRefine(480, 240))

    def forward(self, x):
        return self.decoder(self.refiner(self.encoder(x)[0]))


class ZipDensity(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = Backbone()
        self.bin_head = nn.Conv2d(240, 10, 1)
        self.pi_head = nn.Conv2d(240, 2, 1)
        self.register_buffer("bin_centers", torch.zeros(1, 11, 1, 1))

    def forward(self, x):
        x = self.backbone(x)
        rate = (self.bin_head(x).softmax(dim=1) * self.bin_centers[:, 1:]).sum(dim=1, keepdim=True)
        return self.pi_head(x).softmax(dim=1)[:, 1:] * rate


def load_zip(path, device):
    # weights_only rejects arbitrary pickle code; architecture is local and
    # fixed. strict=True rejects missing or unrelated tensors.
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    config = checkpoint["config"]
    if (config.get("model_name") != "mobilenetv4_conv_small" or config.get("block_size") != 16
            or config.get("zero_inflated") is not True or len(config.get("bin_centers", [])) != 11):
        raise ValueError("Expected the published ZIP-N NWPU checkpoint")
    model = ZipDensity()
    model.load_state_dict(checkpoint["weights"], strict=True)
    return model.to(device).eval()
