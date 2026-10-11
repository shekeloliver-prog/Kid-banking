// Tiny hyperscript helper. Text is always added as text nodes (never parsed as HTML),
// so anything a user typed can't turn into markup.

function append(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return;
  if (Array.isArray(child)) child.forEach((c) => append(parent, c));
  else if (child instanceof Node) parent.appendChild(child);
  else parent.appendChild(document.createTextNode(String(child)));
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'for') el.setAttribute('for', value);
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
      else if (key === 'style' && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) el.style.setProperty(k.startsWith('--') ? k : k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), String(v));
      } else if (key.startsWith('aria-') || key === 'role' || key.startsWith('data-') || !(key in el)) {
        el.setAttribute(key, value === true ? '' : String(value));
      } else el[key] = value;
    }
  }
  children.forEach((c) => append(el, c));
  return el;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  children.forEach((c) => append(f, c));
  return f;
};

export function setBusy(button, busy) {
  button.classList.toggle('is-loading', busy);
  button.disabled = busy;
}
