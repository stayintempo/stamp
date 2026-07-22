import { useEffect, useRef } from 'preact/hooks';
import { renderMarkdown } from '../lib/markdown';
import { rewriteLinks, type LinkContext } from '../lib/links';

interface Props {
  markdown: string | undefined;
  ctx: LinkContext;
  /** Container class (defaults to "body"). */
  class?: string;
}

/**
 * Render markdown into a container and finalize it: sanitize (via renderMarkdown),
 * rewrite every link's target/rel (reverse-tabnabbing safe), and enable nested
 * checkboxes as tester-local toggles. This is the single rendering surface for
 * ALL doc-controlled markdown (step bodies, separators, preamble, phase/group
 * intros) so no surface can escape link rewriting.
 */
export function Markdown({ markdown, ctx, class: cls }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!markdown) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = renderMarkdown(markdown);
    rewriteLinks(el, ctx);
    el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((box) => {
      box.disabled = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown, ctx.filePath, ctx.sha, ctx.appHost, ctx.owner, ctx.repo]);
  return <div class={cls ?? 'body'} ref={ref} />;
}
