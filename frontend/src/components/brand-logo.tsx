import Image from "next/image";
import styles from "./brand-logo.module.css";

export default function BrandLogo({
  variant = "wordmark",
  className,
  alt = "Crowdy",
  preload = false,
}: {
  variant?: "wordmark" | "symbol";
  className?: string;
  alt?: string;
  preload?: boolean;
}) {
  const wordmark = variant === "wordmark";

  return (
    <span className={`${styles.logo} ${styles[variant]} ${className ?? ""}`}>
      <Image
        src={`/brand/crowdy-${variant}.png`}
        alt={alt}
        width={wordmark ? 1536 : 1254}
        height={wordmark ? 1024 : 1254}
        sizes={wordmark ? "192px" : "(max-width: 700px) 240px, 420px"}
        preload={preload}
      />
    </span>
  );
}
