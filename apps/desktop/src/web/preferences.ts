// The desktop app's first-run steps that don't apply in a browser are marked done before it starts:
// the computer-access setup (screen recording, accessibility) is about the desktop's own computer.
export function presetWebPreferences() {
  try {
    if (localStorage.getItem('computerAccessSetup') === null) localStorage.setItem('computerAccessSetup', JSON.stringify('later'))
  } catch {
    // Storage blocked: the app shows those steps, which only costs a click.
  }
}
