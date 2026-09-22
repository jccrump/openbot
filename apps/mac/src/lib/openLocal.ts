export async function openPathOnMac(path: string): Promise<boolean> {
  if (!("__TAURI_INTERNALS__" in window)) {
    return false;
  }
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
    return true;
  } catch {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
      return true;
    } catch {
      return false;
    }
  }
}
