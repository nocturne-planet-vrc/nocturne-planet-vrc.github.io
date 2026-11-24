const borderSides = ['top', 'right', 'bottom', 'left'];
const uncoloredFill = /^(?:transparent|white|rgb\(255,\s*255,\s*255\))$/i;

function tableTint(theme, source) {
  const tint = `color-mix(in srgb, ${theme} 88%, ${source})`;
  return CSS.supports('color', `color-mix(in srgb, black 88%, ${source})`) ? tint : theme;
}

export function applyManualFormat(root) {
  for (const element of root.querySelectorAll('[data-manual-style]')) {
    const { style } = element;
    // Apply validated declarations individually under the site's style-src policy.
    for (const declaration of element.dataset.manualStyle.split(';')) {
      const [property, value] = declaration.split(':');
      if (value) style.setProperty(property, value);
    }
    if (!element.closest('.manual-doc-body table')) continue;
    const headingCell = element.matches('th, thead td');
    if (style.backgroundColor) {
      if (uncoloredFill.test(style.backgroundColor)) style.removeProperty('background-color');
      else {
        const fill = headingCell ? 'var(--raised)' : 'var(--manual-table-highlight)';
        style.backgroundColor = tableTint(fill, style.backgroundColor);
      }
    }
    if (style.color) style.color = tableTint('var(--ink)', style.color);
    for (const side of borderSides) {
      const property = `border-${side}-color`;
      if (style.getPropertyValue(property))
        style.setProperty(property, headingCell && side === 'bottom' ? 'var(--gold)' : 'var(--manual-table-line)');
    }
  }
}
