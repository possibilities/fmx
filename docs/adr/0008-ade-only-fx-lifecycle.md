# ADE is the only Fx lifecycle channel

Superseded by [ADR 0016](0016-sessions-are-arbitrary-commands.md): smolmux has no
lifecycle channel at all, and a caller that needs one reads screens.

smolmux launches Fx with ADE as its only lifecycle binding, accepting a passive best-effort feed because every schema-1 record carries a complete lifecycle snapshot that repairs dropped transitions without charging reply latency to Fx. Other hosts may opt into their own Fx projections independently, while smolmux requires fxnk 0.5.0 or newer for the complete ADE contract.
