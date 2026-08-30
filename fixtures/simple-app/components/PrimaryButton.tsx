import type { ReactNode } from "react";

export function PrimaryButton({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return (
    <button className="primary" onClick={onClick}>
      {children}
    </button>
  );
}
