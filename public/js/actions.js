// A button that asks for confirmation in the page (no browser dialogs), runs an
// action, and shows the outcome in place. Used for accept and restore. (P043)
//
// States: idle → confirming → working → done, or → failed (with "Try again",
// plus a fallback such as "Accept the screenshots that worked" when offered).

import { h } from "./dom.js";

/**
 * @param {{
 *   id: string,
 *   label: string,                       // idle button, e.g. "Accept all pages"
 *   question: string | Node,             // shown when confirming
 *   confirmLabel: string,                // e.g. "Yes, accept"
 *   workingLabel: string,                // e.g. "Accepting…"
 *   action: (options: Record<string, unknown>) => Promise<unknown>,
 *   success: (result: any) => string | Node | (string | Node)[],
 *   fallback?: (err: any) => { label: string, options: Record<string, unknown>, note?: string } | null,
 *   onDone?: (result: any, box: HTMLElement) => void, // box holds the success message
 *   primary?: boolean,
 * }} spec
 */
export function confirmable(spec) {
  const box = h("div", { class: "action", id: spec.id, "data-state": "idle" });

  const button = (label, attrs, onclick) =>
    h("button", { type: "button", class: "button", ...attrs, onclick }, label);

  function idle() {
    box.dataset.state = "idle";
    box.replaceChildren(
      button(
        spec.label,
        { class: `button${spec.primary ? " button--primary" : ""}`, "data-role": "start" },
        confirming
      )
    );
  }

  function confirming() {
    box.dataset.state = "confirming";
    const yes = button(
      spec.confirmLabel,
      { class: "button button--primary", "data-role": "confirm" },
      () => run({})
    );
    box.replaceChildren(
      h(
        "div",
        { class: "confirm", role: "group", "aria-label": "Confirm" },
        h("p", {}, spec.question),
        h(
          "div",
          { class: "confirm-buttons" },
          yes,
          button("Cancel", { "data-role": "cancel" }, () => {
            idle();
            box.querySelector("button")?.focus();
          })
        )
      )
    );
    yes.focus();
  }

  async function run(options) {
    box.dataset.state = "working";
    box.replaceChildren(
      h(
        "p",
        { class: "working", role: "status" },
        h("span", { class: "spinner" }),
        spec.workingLabel
      )
    );
    let result;
    try {
      result = await spec.action(options);
    } catch (err) {
      failed(err);
      return;
    }
    box.dataset.state = "done";
    box.replaceChildren(
      h("div", { class: "notice notice--ok", role: "status" }, spec.success(result))
    );
    spec.onDone?.(result, box);
  }

  function failed(err) {
    box.dataset.state = "failed";
    const offer = spec.fallback?.(err) ?? null;
    box.replaceChildren(
      h(
        "div",
        { class: "notice notice--error", role: "alert" },
        h("p", {}, h("strong", {}, "Nothing was changed. "), err?.message ?? String(err)),
        offer?.note ? h("p", {}, offer.note) : null,
        h(
          "div",
          { class: "confirm-buttons" },
          offer
            ? button(
                offer.label,
                { class: "button button--primary", "data-role": "fallback" },
                () => run(offer.options)
              )
            : null,
          button("Try again", { "data-role": "retry" }, () => run({})),
          button("Cancel", { "data-role": "cancel" }, idle)
        )
      )
    );
  }

  idle();
  return box;
}
