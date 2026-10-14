// Deterministic app icon asset generation; no compiler or external dependencies.
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib');
const dir=path.resolve(__dirname,'../src-tauri/icons');fs.mkdirSync(dir,{recursive:true});
function crc32(data){let c=0xffffffff;for(const byte of data){c^=byte;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);}
function png(size){
 const raw=Buffer.alloc((size*4+1)*size);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){
  const a=x/size,b=y/size,ring=Math.hypot(a-.47,b-.5);
  const mark=(ring>.23&&ring<.30&&(a<.5||b<.30||b>.70)) || (a>.54&&a<.78&&b>.42&&b<.48) || (a>.71&&a<.78&&b>.42&&b<.63);
  const offset=y*(size*4+1)+1+x*4;raw.set(mark?[179,231,188,255]:[16,23,22,255],offset);
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const images=new Map([16,32,64,128,256,512,1024].map(size=>[size,png(size)]));
const large=images.get(1024),medium=images.get(256);fs.writeFileSync(path.join(dir,'icon.png'),large);
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(medium.length,14);ico.writeUInt32LE(22,18);fs.writeFileSync(path.join(dir,'icon.ico'),Buffer.concat([ico,medium]));
// Include standard and Retina representations; ic10 is 512pt @2x (1024px),
// required by App Store Connect. Render each size from the original geometry.
const entries=[['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024],['ic11',32],['ic12',64],['ic13',256],['ic14',512]].map(([type,size])=>{
 const image=images.get(size),header=Buffer.alloc(8);header.write(type);header.writeUInt32BE(8+image.length,4);return Buffer.concat([header,image]);
});
const icns=Buffer.alloc(8);icns.write('icns');icns.writeUInt32BE(8+entries.reduce((total,entry)=>total+entry.length,0),4);fs.writeFileSync(path.join(dir,'icon.icns'),Buffer.concat([icns,...entries]));
