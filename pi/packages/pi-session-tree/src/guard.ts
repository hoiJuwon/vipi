export function shouldSelfRegister(isTTY: boolean, tmuxEnv: string | undefined): boolean {
  return Boolean(tmuxEnv) && isTTY;
}
