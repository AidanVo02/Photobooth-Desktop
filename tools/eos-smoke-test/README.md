# Canon EOS smoke test

This isolated test connects to the first Canon EOS camera through the 32-bit
EDSDK installed with EOS Utility, triggers one still photo, and downloads the
JPEG to this directory. It does not change the Electron photobooth flow.

Before running it:

1. Connect and power on the EOS 60D with a data-capable USB cable.
2. Set the camera to a still-photo mode and disable Auto Power Off.
3. Close EOS Utility and its launcher so only this test owns the camera.
4. Make sure the camera is configured to record JPEG (JPEG-only is preferred
   for this first test).

Run from PowerShell:

```powershell
.\tools\eos-smoke-test\run-eos-smoke-test.ps1
```

The expected output is `tools/eos-smoke-test/eos60d-test.jpg`.
