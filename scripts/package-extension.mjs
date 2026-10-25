// Small dependency-free ZIP writer (stored entries); paths are a fixed allowlist.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const filenames=['manifest.json','popup.html','popup.css','popup.js','background.js','content.js','offscreen.html','offscreen.js','media-popup.js'];
function crc32(buffer){let crc=0xffffffff;for(const value of buffer){crc^=value;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
const chunks=[],directory=[];let offset=0;
for(const filename of filenames){
  const name=Buffer.from(filename),data=await readFile(`extension/${filename}`),crc=crc32(data);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  chunks.push(local,name,data);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
  directory.push(central,name);offset+=local.length+name.length+data.length;
}
const central=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(filenames.length,8);end.writeUInt16LE(filenames.length,10);end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
await mkdir('public',{recursive:true});await writeFile('public/safenet-extension.zip',Buffer.concat([...chunks,central,end]));
console.log('Chrome/Edge extension packaged.');
