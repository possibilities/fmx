# ADE is the only Fx lifecycle channel

fmx launches Fx with an ADE binding and no Herdr binding, accepting a passive best-effort feed because every schema-1 record carries a complete lifecycle snapshot that repairs dropped transitions without charging reply latency to Fx. Fx's upstream Herdr projection remains independently available to other hosts, while fmx requires fxnk 0.5.0 or newer for the complete ADE contract.
