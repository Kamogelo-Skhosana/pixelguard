// Tiny DOM helper. Text is always set with textContent, never innerHTML,
// so data from runs (page names, notes, URLs) can't inject HTML.
// Ticket: P039

/**
 * h("a", { href: "#/runs/1", class: "link" }, "Run 1", child...)
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | number | null | undefined | false)} children
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "class") {
      el.className = value;
    } else {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Like h(), but creates SVG elements (for the trend chart). Ticket: P041
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {...(Node | string | number | null | undefined | false)} children
 */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      el.setAttribute(key === "className" ? "class" : key, value === true ? "" : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
