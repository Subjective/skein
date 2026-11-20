/** Chromium's net error names, in words. Unknown ones keep their name, which is still searchable. */
const NET_ERRORS: Record<string, string> = {
  CONNECTION_REFUSED: 'nothing is listening there',
  CONNECTION_RESET: 'the connection was reset',
  CONNECTION_CLOSED: 'the server closed the connection',
  EMPTY_RESPONSE: 'the server sent nothing back',
  NAME_NOT_RESOLVED: 'no such host',
  ADDRESS_UNREACHABLE: 'the address is unreachable',
  INTERNET_DISCONNECTED: 'no network connection',
  TIMED_OUT: 'it timed out',
  CONNECTION_TIMED_OUT: 'it timed out',
  UNSAFE_PORT: 'that port is blocked',
  CERT_AUTHORITY_INVALID: 'its certificate is not trusted',
  CERT_COMMON_NAME_INVALID: "its certificate doesn't match the host",
  SSL_PROTOCOL_ERROR: 'it does not speak https',
};
export function loadError(desc: string): string {
  const name = desc.replace(/^net::/, '').replace(/^ERR_/, '');
  return NET_ERRORS[name] || desc.replace(/^net::/, '') || 'it failed';
}
