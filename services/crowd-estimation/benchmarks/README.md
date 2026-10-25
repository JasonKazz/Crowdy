# Actual density validation

Measured 2026-10-24 on an Apple M4 CPU with two PyTorch threads, using the
reviewed local ZIP-N architecture and pinned author NWPU checkpoint. Whole-view
processing preserves aspect ratio, uses a minimum edge of 896, and sums the
native density map once. See [machine-readable results](validation.json) for
raw totals, timings, cap metadata and source/annotation SHA-256 hashes.

| UCF-QNRF original | Labeled people | Raw estimate | Absolute relative error | Model time |
| --- | ---: | ---: | ---: | ---: |
| img_0340 | 12672 | 14001 | 10.5% | 565 ms |
| img_0341 | 5387 | 2722 | 49.5% | 190 ms |
| img_0424 | 10274 | 8297 | 19.2% | 1222 ms |
| img_0727 | 6052 | 6337 | 4.7% | 560 ms |
| img_1042 | 7930 | 7101 | 10.5% | 740 ms |
| img_1194 | 12865 | 8072 | 37.3% | 606 ms |

All six selected images are reported, including the large errors. The three
largest annotation files were selected first, followed by three annotation
files in the 65000–95000-byte range to obtain examples near 5000–8000 people.
This is an illustrative cross-dataset evaluation, not randomized test-set MAE,
not a proof of accuracy for every 5000/10000-person view, and not a calibrated
error interval. Dataset overlap with the model's NWPU training images has not
been audited. Predictions above 10000 retain their raw total but return a
public count capped at 10000 with `truncated: true, complete: false`.

The [official UCF-QNRF dataset](https://www.crcv.ucf.edu/data/ucf-qnrf/)
provides the original images and point annotations; annotation count is the
number of rows in the original N×2 head-point matrix. Only the selected files
were fetched from the author's archive using HTTP byte ranges. Images and
weights are kept outside version control; no user photos or dataset images
are redistributed here.

Additional stress checks used the [official UCF-CC-50
dataset](https://www.crcv.ucf.edu/data/ucf-cc-50/): its low-resolution 4633-person
scene produced an estimate of 1580, while scenes containing 3406 and 2961
produced 3269 and 3558. This severe low-resolution failure is material. Digital
enlargement does not restore missing detail, and wide cameras must provide
enough real head pixels. A complete scan does not imply accurate attendance.

Three unlabeled user-supplied POFA wide-view photos yielded estimates 96, 98,
and 95 in approximately 250–260 ms. No ground-truth accuracy claim is made.
A close-up selfie yielded 2 rather than the single visible person, confirming
that the default model is intended for wide crowds, not close-up portraits.
The older whole-image YOLO detector returned 19, 14, and 15 for the same POFA
wide views and 0, 14, and 10 on the three CC-50 dense scenes. Native-resolution
YOLO tiles improved these to 18/45/35 and 1/16/25; that detector remains unsuitable
for thousands of tiny heads. It remains an explicit alternate mode for visible
individuals and real boxes.

Run `python -m app.benchmark --ucf-labels /path/to/img_0727.jpg` with the service
environment and adjacent original `img_0727_ann.mat` to reproduce the density
inference path. Model timings exclude upload/decoding and vary by hardware.
Actual HTTP uploads of the 6052- and 7930-person scenes were also tested after
JPEG quality-88 preparation to 2.27MB and 2.64MB, fitting the browser's 3MiB
limit. They returned 6290 (+3.9%) and 7005 (-11.7%) in 734ms and 1211ms total,
with 546- and 545-byte density responses. These checks include actual image
decoding and model inference, rather than mocked predictions.
A separate 4096×2304 resampled-input stress run completed in 2680ms with peak
process RSS 2.04GB on the same Mac. It validates 4K runtime/memory behavior,
not additional accuracy. Keep the deployment's 4Gi memory budget and one
inference slot; Linux/container performance must be checked separately.
The synthetic 5000/10000 box-output tests in `tests/test_tiling.py` validate
stitching/transport capacity only; the actual labeled model runs above are the
evidence for dense counting behavior.

Published model: [ZIP-N](https://huggingface.co/Yiming-M/ZIP-N), revision
`5885abd667066660bd094cec2d584e5926371914`, checkpoint 13735297 bytes,
SHA-256 `30474977b7979394469802b0b5e57476391252c86a1e5fd3248aa255d28d817e`.
The author's [paper and source](https://github.com/Yiming-M/ZIP) provide the
training protocol and full dataset metrics; their aggregate results must not
be confused with this small deployment check.
