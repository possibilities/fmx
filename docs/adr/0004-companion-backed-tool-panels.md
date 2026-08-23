# Persistent Tool panels use the existing Companion

Each persistent configured terminal tool has a deterministic Companion session keyed by Home, stable Instance identity, and an id-plus-command fingerprint, so Detach can release its transport and the next fmx can restore it without changing the zmx protocol. Non-persistent tools instead use fmx-owned Bun PTYs, and startup reconciliation kills or forgets stale persistent sessions only when their complete ownership labels agree; an ambiguous session is left untouched.
