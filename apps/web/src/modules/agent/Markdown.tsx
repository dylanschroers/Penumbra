import ReactMarkdown, { type Options } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

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

const remarkPlugins: Options["remarkPlugins"] = [remarkGfm];
const rehypePlugins: Options["rehypePlugins"] = [[rehypeSanitize, schema]];

export function Markdown({ children }: { children: string }) {
  return (
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
  );
}
