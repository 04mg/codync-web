// codync-web's sign-in page: the access key (or the server's password) opens a session cookie.
const form = document.getElementById('form') as HTMLFormElement
const secret = document.getElementById('secret') as HTMLInputElement
const submit = document.getElementById('submit') as HTMLButtonElement
const error = document.getElementById('error') as HTMLParagraphElement

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  submit.disabled = true
  error.hidden = true
  try {
    const res = await fetch('auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: secret.value }),
    })
    if (res.ok) {
      location.replace(new URL('.', location.href).toString())
      return
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    error.textContent = body.error ?? `Sign-in failed (${res.status}).`
  } catch {
    error.textContent = "Can't reach the server."
  }
  error.hidden = false
  submit.disabled = false
  secret.select()
})
