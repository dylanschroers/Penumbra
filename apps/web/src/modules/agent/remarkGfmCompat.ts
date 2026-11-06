import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

interface ParserData {
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
}

/**
 * remark-gfm without mdast-util-gfm-autolink-literal's `transforms` step.
 *
 * That step uses a regex lookbehind, which WebKit before Safari 16.4 (macOS
 * before 13.3, so the desktop window there) cannot parse. It threw on the first
 * reply and, with nothing catching it, blanked the whole app. The tokenizer
 * still links bare URLs, `www.` hosts and emails without it.
 */
export function remarkGfmCompat(this: { data(): object }): void {
  const data = this.data() as ParserData;
  data.micromarkExtensions ??= [];
  data.fromMarkdownExtensions ??= [];
  data.micromarkExtensions.push(gfm());
  data.fromMarkdownExtensions.push(
    gfmFromMarkdown().map(({ transforms: _, ...extension }) => extension),
  );
}
