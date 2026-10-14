'use strict';
// Provider-independent contracts. Real adapters must be explicitly included by the build.
(function(root,factory){
 const create=factory();
 if(typeof module==='object'&&module.exports)module.exports=create;
 else root.createClientServices=create;
})(globalThis,()=>{
 const methods=Object.freeze({billing:['listOffers','purchase','restore','manageSubscription'],ads:['show'],analytics:['track'],push:['requestPermission']});
 const unsupported=async()=>Object.freeze({status:'unsupported',reason:'provider_disabled'});
 function create(manifest){
  const services={};
  for(const [kind,names] of Object.entries(methods)){
   if(manifest.modules?.[kind]!=='disabled')throw Error(`SDK adapter not implemented: ${kind}/${manifest.modules?.[kind]}`);
   services[kind]=Object.freeze({provider:'disabled',capabilities:Object.freeze({available:false}),...Object.fromEntries(names.map(name=>[name,unsupported]))});
  }
  // No paid grants exist until a trusted provider is connected. This is not a purchase cache.
  services.entitlements=Object.freeze({snapshot:async()=>Object.freeze({status:'unconfigured',grants:Object.freeze([])})});
  return Object.freeze(services);
 }
 return create;
});
