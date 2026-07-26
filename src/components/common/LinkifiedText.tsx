import { openExternalUrl } from "./external";

// Renders plain text with bare URLs turned into clickable links that open in the
// system browser. Used for tool output where the text is not markdown.
export function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"'）)\]】]+)/g);
  return (
    <>
      {parts.map((part, index) =>
        /^https?:\/\//i.test(part) ? (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noreferrer"
            title="用系统浏览器打开"
            onClick={(event) => {
              event.preventDefault();
              openExternalUrl(part);
            }}
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}
