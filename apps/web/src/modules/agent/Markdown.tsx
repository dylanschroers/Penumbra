import { Component, type ReactNode } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { remarkGfmCompat } from "./remarkGfmCompat";

// Renders assistant text as sanitized GitHub-flavored markdown. The model is
// untrusted content, so this must never grow a raw-HTML path (no rehype-raw):
// react-markdown drops embedded HTML by default and rehype-sanitize is the
// belt-and-suspenders that also constrains attributes and URL schemes.

// Start from the GitHub-like default schema, then drop images — a local
// assistant should never fetch a remote URL the model chose (tracking/exfil).
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((t) => t !== "img"),
};

const remarkPlugins: Options["remarkPlugins"] = [remarkGfmCompat];
const rehypePlugins: Options["rehypePlugins"] = [[rehypeSanitize, schema]];

/** Shows the reply as plain text if rendering it throws, instead of letting
 *  one reply unmount the whole app. */
class PlainTextOnError extends Component<
  { text: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error("[agent] markdown render failed; showing plain text", error);
  }

  override render() {
    return this.state.failed ? this.props.text : this.props.children;
  }
}

export function Markdown({ children }: { children: string }) {
  return (
    // Keyed on the text so a later reply gets a fresh attempt at markdown.
    <PlainTextOnError key={children} text={children}>
      <div className="agent__markdown">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          // Links are safe post-sanitize (javascript: is stripped); still open
          // them out of the app so a click never navigates the shell away.
          components={{
            a: ({ node: _node, ...props }) => (
              <a {...props} target="_blank" rel="noopener noreferrer" />
            ),
          }}
        >
          {children}
        </ReactMarkdown>
      </div>
    </PlainTextOnError>
  );
}
