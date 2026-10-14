# Local changes to the vendored source snapshot

Snapshot provenance is recorded in source.json; its `revision` is not asserted to be an upstream commit. The changes below are maintained in this vendored copy. See README.md for the dependency and update policy.

* `tailscale.go`: send a fixed-size peer-address frame with SCM_RIGHTS; associate it with the **received** descriptor in TsnetAccept. The upstream code keyed metadata by the original descriptor, closed it, and populated the mapping after sendmsg. Receiver descriptor allocation/reuse made getremoteaddr fail or return another peer. Concurrent accepts now serialize frame receipt.
* `tsnetctest`: occupy an additional descriptor before accept and verify remote metadata belongs to the dialing node.

The C ABI is unchanged. Build both ends from this vendored source; do not mix archive versions. BSD-3-Clause notices are preserved.
