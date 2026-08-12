# EOS camera service

Internal 32-bit helper used by the Electron main process to control the Canon
EOS 60D through the EDSDK installed with EOS Utility 2. It owns one camera
session and accepts line-based commands over standard input.

EOS Utility must be completely closed before this service starts.
