"use client";

import Link from "next/link";
import type { ComponentProps } from "react";

type Props = Omit<
  ComponentProps<typeof Link>,
  "href" | "prefetch" | "onNavigate"
> & { href: string };

export default function WorkspaceLink({ href, ...props }: Props) {
  return (
    <Link
      {...props}
      href={href}
      prefetch={false}
      onNavigate={(event) => {
        // A new editor must load a fresh saved snapshot rather than a cached draft.
        event.preventDefault();
        window.location.assign(href);
      }}
    />
  );
}
