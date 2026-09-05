export function boxTop(title: string, innerW: number): string {
  let titleStr = ` ${title} `.trim().length > 0 ? ` ${title} ` : "";
  if (titleStr.length > innerW) {
    titleStr = titleStr.slice(0, innerW);
  }
  const left = Math.floor((innerW - titleStr.length) / 2);
  const right = innerW - titleStr.length - left;
  return `╭${"─".repeat(left)}${titleStr}${"─".repeat(right)}╮`;
}

export function boxBottom(innerW: number): string {
  return `╰${"─".repeat(innerW)}╯`;
}

export function boxRow(content: string, innerW: number): string {
  return `│${content.padEnd(innerW)}│`;
}

export function labelDivider(label: string, innerW: number): string {
  const text = ` ${label} `;
  if (text.length >= innerW) return text.slice(0, innerW);
  const left = Math.floor((innerW - text.length) / 2);
  const right = innerW - text.length - left;
  return `${"┄".repeat(left)}${text}${"┄".repeat(right)}`;
}
