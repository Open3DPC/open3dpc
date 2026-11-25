// The "open the scanner on your phone" block: a QR code, the address and a copy button.
// Copyright 2026 Roman Simonov. Licensed under the Apache License, Version 2.0.
import { qrSvg } from './qr.js';

/** Fills `[data-phone]` with a way to the scanner: a QR code beside a keyboard, a button under a thumb. */
export function phoneBlock(element, address = new URL('./scan/', import.meta.url).href) {
  const shown = address.replace(/^https?:\/\//, '').replace(/\/$/, '');
  element.innerHTML = `<a class="open-scanner" href="">Open the scanner</a><div class="phone-qr"></div>
    <div class="phone-text"><h2>Open the 3DPC Scanner on your phone</h2><p>Point the camera at the QR code. No app to install, and the pictures never leave the phone.</p>
    <p class="phone-link"><a href=""></a> <button type="button">Copy link</button></p></div>`;
  element.querySelector('.phone-qr').innerHTML = qrSvg(address, 'QR code that opens the scanner');
  for (const link of element.querySelectorAll('a')) link.href = address;
  element.querySelector('.phone-link a').textContent = shown;
  const button = element.querySelector('button');
  button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(address); button.textContent = 'Copied'; } catch { getSelection().selectAllChildren(element.querySelector('.phone-link a')); }
  });
}
