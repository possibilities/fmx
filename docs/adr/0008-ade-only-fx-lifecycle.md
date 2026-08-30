# ADE is the only Fx lifecycle channel

fmx launches Fx with ADE as its only lifecycle binding, accepting a passive best-effort feed because every schema-1 record carries a complete lifecycle snapshot that repairs dropped transitions without charging reply latency to Fx. Other hosts may opt into their own Fx projections independently, while fmx requires fxnk 0.5.0 or newer for the complete ADE contract.
