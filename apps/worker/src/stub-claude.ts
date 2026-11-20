import type Anthropic from "@anthropic-ai/sdk";

/*
  HIRING-TEST COPY ONLY. Nothing here talks to Anthropic.

  A stand-in for the one Claude client the worker uses (claude.ts
  createClient). Every call answers at once with a canned reply, so the app
  runs end to end with zero API calls and zero cost. The worker only ever
  uses messages.stream(...).finalMessage() and models.retrieve/list, so that
  is all this offers.

  The canned replies are shaped to pass the same reply checks the real
  answers pass (readPartsReply, readPageReply), so the rest of the build
  runs for real on them.
*/

/* Written the way a model often writes it. TAWD's phone-layout rule (formatSitePhones) then rewrites it as "(530) 227-2479". */
export const STUB_PHONE = "530.227.2479";

const HEADER_AND_FOOTER = `<header class="site-header"><a class="skip" href="#main" style="position:absolute;left:-9999px">Skip to content</a><a class="logo" href="/">Sample Plumbing Co.</a><nav><a href="/">Home</a> <a href="/about/">About</a> <a href="/contact/">Contact</a></nav><a class="call" href="tel:+15302272479">Call ${STUB_PHONE}</a></header>
<footer class="site-footer"><p>Sample Plumbing Co. &middot; Call ${STUB_PHONE}</p><p>Website by Velocity Media Lab</p></footer>`;

const PAGE = `<main id="main"><h1>Stub page</h1><p>A canned answer: no AI was asked and nothing was spent.</p></main>`;

function cannedText(params: Anthropic.MessageStreamParams): string {
  const last = params.messages[params.messages.length - 1];
  const text =
    typeof last?.content === "string"
      ? last.content
      : (last?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join(" ");
  // The header-and-footer step (buildPartsPrompt) asks for exactly those two elements.
  if (/Rewrite the header and footer|<header> element, then the <footer> element/i.test(text)) return HEADER_AND_FOOTER;
  return PAGE;
}

export function stubClient(): Anthropic {
  const stream = (params: Anthropic.MessageStreamParams) => {
    const message = {
      id: "stub-message",
      type: "message",
      role: "assistant",
      model: params.model,
      content: [{ type: "text", text: cannedText(params), citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Message;
    return { finalMessage: async () => message, on: () => undefined, abort: () => undefined };
  };
  return {
    messages: { stream },
    models: {
      retrieve: async (id: string) => ({ id }),
      list: async () => ({ data: [{ id: "stub-model" }] }),
    },
  } as unknown as Anthropic;
}
