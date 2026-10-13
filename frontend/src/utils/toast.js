import { reactive } from 'vue'

export const toastState = reactive({ show: false, ok: true, text: '' })
let timer = null

export function toast(text, ok = true) {
  toastState.text = text
  toastState.ok = ok
  toastState.show = true
  clearTimeout(timer)
  timer = setTimeout(() => { toastState.show = false }, 2600)
}
