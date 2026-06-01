
export async function generateIdentity(){
 return crypto.subtle.generateKey(
  {name:'Ed25519'},
  true,
  ['sign','verify']
 )
}
