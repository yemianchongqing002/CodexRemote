# Connection code ownership

Connection behavior uses the current protocol only. Version checks reject unsupported servers; they are not alternate protocol implementations.

| Responsibility | Entry point |
| --- | --- |
| UI platform calls | `Runtime.invoke` |
| User address parsing and canonicalization | `normalizeAddress` in `client/ui/address.js` |
| Save/reuse a computer | `Runtime.rememberComputer` |
| Check release and open a computer | `Runtime.select` (reuses a matching probe result from the add-computer flow) |
| Discover devices and render network settings | `ConnectionNetwork.refresh` in `client/ui/tailnet.js` |
| Service check and SSH guidance | `client/ui/connect.js` |
| SSH credentials and installation | `client/ui/deploy.js` |
| Browser-host transport ownership | `Network` in `client/web/network.cjs` |
| HTTP and SSH routing decision | `Network.route` |
| Service readiness check | `serviceProbe` in `client/web/service-probe.cjs` |

The computer input is the only device picker. Network settings no longer have a second picker or a shortcut that skips service checking. Service installation reuses computer storage and service probing instead of maintaining another connection path.

Concurrent discovery requests share one pending operation. The host caches system discovery for two seconds so HTTP requests and SSH probes do not each spawn a Tailscale CLI process. Changing the outgoing network never closes the shared incoming embedded listener.

The current public version endpoint is required for a service returning 401. A ready status response must include release metadata; missing metadata is rejected instead of querying an alternate endpoint as an old-server fallback. Unknown versions remain distinct from confirmed unsupported versions.

Browser and native backends remain separate platform implementations behind the same UI command interface. No claim is made that Node and Rust can share the same executable functions.

For the browser bridge, invalid Origin stays a 403 rejection. An old page key after a host restart receives 409 / CLIENT_RESTARTED with a refresh instruction. No write request, SSH installation, or message is automatically replayed.
