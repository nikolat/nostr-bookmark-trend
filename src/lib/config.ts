import { npubEncode } from 'nostr-tools/nip19';
import type { WindowNostr } from 'nostr-tools/nip07';

export const defaultRelays = [
	'wss://relay-jp.nostr.wirednet.jp/',
	'wss://yabu.me/',
	'wss://nos.lol/',
	'wss://relay.damus.io/',
];
export const linkGitHub = 'https://github.com/nikolat/nostr-bookmark-trend';
export const linkto = 'https://nostx.io/';
export const threshold = 2;
export const getRoboHashURL = (pubkey: string) => {
	return `https://robohash.org/${npubEncode(pubkey)}?set=set4`;
};

declare global {
	interface Window {
		nostr?: WindowNostr;
	}
}
