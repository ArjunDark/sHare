
export class PeerSync{
 peer?:RTCPeerConnection
 connect(){
  this.peer = new RTCPeerConnection()
 }
}
