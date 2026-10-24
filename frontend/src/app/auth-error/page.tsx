import Link from "next/link";
import styles from "./page.module.css";

export default function AuthErrorPage() {
  return (
    <main className={styles.page}>
      <section className={styles.message}>
        <span className={styles.label}>CROWDY ACCOUNT</span>
        <h1>Sign-in couldn’t finish</h1>
        <p>
          The sign-in link may have expired or authorization was cancelled. Your
          saved workspaces are still in your account.
        </p>
        <div className={styles.actions}>
          <Link className="button secondary" href="/">
            Back to workspace
          </Link>
          <a className="button primary" href="/auth/login?returnTo=/">
            Try signing in again
          </a>
        </div>
      </section>
    </main>
  );
}
