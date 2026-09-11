import { Fragment } from "react";

export type Seg = { text: string; cls?: string };
export type TLine = Seg[];

export function ChromeBar({ label }: { label: string }) {
  return (
    <div className="chrome-bar">
      <i></i>
      <i></i>
      <i></i>
      <span>{label}</span>
    </div>
  );
}

export function TermPre({
  lines,
  id,
}: {
  lines: TLine[];
  id?: string;
}) {
  return (
    <pre id={id}>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {line.map((seg, j) =>
            seg.cls ? (
              <span key={j} className={seg.cls}>
                {seg.text}
              </span>
            ) : (
              <Fragment key={j}>{seg.text}</Fragment>
            )
          )}
          {i < lines.length - 1 ? "\n" : null}
        </Fragment>
      ))}
    </pre>
  );
}

export function linesToText(lines: TLine[]): string {
  return lines.map((line) => line.map((seg) => seg.text).join("")).join("\n");
}
