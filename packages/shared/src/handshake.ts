export interface HelloMessage {
  type: "qcode-hello";
  version: string;
  platform: string;
  arch: string;
  pid: number;
}

export interface HelloAckMessage {
  type: "qcode-hello-ack";
  version: string;
  clientId: string;
}
