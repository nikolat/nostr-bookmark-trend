<script lang='ts'>
import { NostrFetcher, type NostrEventWithAuthor } from 'nostr-fetch';
import { nip19, type NostrEvent } from 'nostr-tools';
import { insertEventIntoDescendingList } from 'nostr-tools/utils';
import type { WindowNostr } from 'nostr-tools/nip07';

interface Window {
	nostr?: WindowNostr;
}

const defaultRelays = [
	'wss://relay-jp.nostr.wirednet.jp',
	'wss://yabu.me',
	'wss://nos.lol',
	'wss://relay.damus.io',
];
const linkGitHub = 'https://github.com/nikolat/nostr-bookmark-trend';
const linkto = 'https://nostx.io/';
const threshold = 2;
const getRoboHashURL = (pubkey: string) => {
	return `https://robohash.org/${nip19.npubEncode(pubkey)}?set=set4`;
};
const enum SortType {
	Time,
	Count,
};

let npub: string;
let bookmarkedEvents: NostrEvent[] = [];
let bookmarkedPubkeys: Map<string, Set<string>>;
let profiles = new Map<string, any>();
let isGettingEvents = false;
let message = '';
let sort = SortType.Time;

const getNpubWithNIP07 = async () => {
	const nostr = (window as Window).nostr;
	if (nostr?.getPublicKey) {
		let loginPubkey;
		try {
			loginPubkey = await nostr.getPublicKey();
		} catch (error) {
			console.error(error);
			return;
		}
		npub = nip19.npubEncode(loginPubkey);
	}
};

const getBookmarks = async () => {
	bookmarkedPubkeys = new Map<string, Set<string>>();
	let dr;
	try {
		dr = nip19.decode(npub);
	} catch (error) {
		console.error(error);
		return;
	}
	if (dr.type !== 'npub') {
		console.error(`${npub} is not npub`);
		return;
	}
	const loginPubkey = dr.data;
	isGettingEvents = true;
	message = 'getting bookmarks...';
	const fetcher = NostrFetcher.init();
	const ev10002: NostrEvent | undefined = await fetcher.fetchLastEvent(
		defaultRelays,
		{ kinds: [10002], authors: [loginPubkey] },
	);
	let relays: string[] = [];
	if (ev10002 === undefined) {
		relays = defaultRelays;
	}
	else {
		for (const tag of ev10002.tags.filter(tag => tag.length >= 2 && tag[0] === 'r' && URL.canParse(tag[1]))) {
			if (tag.length === 2 || tag[2] === 'read') {
				relays.push(tag[1]);
			}
		}
		if (relays.length === 0) {
			relays = defaultRelays;
		}
	}
	console.log('relays:', relays);
	message = `${relays.length} relays`;
	const ev3: NostrEvent | undefined = await fetcher.fetchLastEvent(
		relays,
		{ kinds: [3], authors: [loginPubkey] },
	);
	if (ev3 === undefined) {
		console.warn('followees is 0');
		isGettingEvents = false;
		return;
	}
	const followingPubkeys = ev3.tags.filter(tag => tag[0] === 'p').map(tag => tag[1]);
	console.log('followees:', followingPubkeys);
	message = `${followingPubkeys.length} followees`;
	const ev10003PerAuthor = fetcher.fetchLastEventPerAuthor(
		{
			authors: followingPubkeys,
			relayUrls: relays
		},
		{ kinds: [10003] },
	);
	const ev30001PerAuthor = fetcher.fetchLastEventPerAuthor(
		{
			authors: followingPubkeys,
			relayUrls: relays
		},
		{ kinds: [30001], '#d': ['bookmark'] },
	);
	let bookmarkNoteIds = new Set<string>();
	[bookmarkNoteIds, bookmarkedPubkeys] = await setBookmarkedPubkeys(ev10003PerAuthor, bookmarkNoteIds, bookmarkedPubkeys);
	[bookmarkNoteIds, bookmarkedPubkeys] = await setBookmarkedPubkeys(ev30001PerAuthor, bookmarkNoteIds, bookmarkedPubkeys);
	const bookmarkNoteIdsTofetch = Array.from(bookmarkNoteIds).filter(id => (bookmarkedPubkeys.get(id)?.size ?? 0) >= threshold);
	const pubkeysToFetch = new Set<string>();
	for (const id of bookmarkNoteIdsTofetch) {
		const ps = bookmarkedPubkeys.get(id);
		if (ps !== undefined && ps.size >= threshold) {
			for (const p of ps) {
				pubkeysToFetch.add(p);
			}
		}
	}
	console.log('followees to fetch:', Array.from(pubkeysToFetch));
	message = `profiles of ${pubkeysToFetch.size} followees fetching...`;
	profiles = new Map<string, object>();
	profiles = await getProfiles(fetcher, relays, Array.from(pubkeysToFetch), profiles);

	bookmarkedEvents = [];
	const inc = 50;
	const max = 1000;
	const until = Math.floor(Date.now() / 1000);
	console.log('fetch bookmark start');
	for (let i = 0; i < bookmarkNoteIdsTofetch.length && i < max; i += inc) {
		console.log(`${i} / ${bookmarkNoteIdsTofetch.length}`);
		message = `${i} / ${bookmarkNoteIdsTofetch.length} fetching events...`;
		const ids = bookmarkNoteIdsTofetch.slice(i, Math.min(i + inc, bookmarkNoteIdsTofetch.length - 1));
		const postIter = fetcher.allEventsIterator(
			relays,
			{ ids: ids },
			{ until: until }
		);
		for await (const ev of postIter) {
			bookmarkedEvents = insertEventIntoDescendingList(bookmarkedEvents, ev);
		}
		const pubkeysOfBookmark = Array.from(new Set<string>(bookmarkedEvents.map(ev => ev.pubkey)));
		const pubkeysGot = new Set<string>(profiles.keys());
		const diff = pubkeysOfBookmark.filter(p => !pubkeysGot.has(p));
		if (diff.length > 0) {
			profiles = await getProfiles(fetcher, relays, diff, profiles);
			bookmarkedEvents = bookmarkedEvents;
		}
	}
	console.log('fetch bookmark end');
	isGettingEvents = false;
	message = 'complete';
};

const setBookmarkedPubkeys = async (itr: AsyncIterable<NostrEventWithAuthor<false>>, bookmarkNoteIds: Set<string>, bookmarkedPubkeys: Map<string, Set<string>>): Promise<[Set<string>, Map<string, Set<string>>]> => {
	for await (const { author, event } of itr ) {
		if (event === undefined) {
			continue;
		}
		for (const id of event.tags.filter(tag => tag[0] === 'e').map(tag => tag[1])) {
			bookmarkNoteIds.add(id);
			let v = bookmarkedPubkeys.get(id);
			if (v === undefined) {
				v = new Set<string>();
			}
			v.add(author);
			bookmarkedPubkeys.set(id, v);
		}
	}
	return [bookmarkNoteIds, bookmarkedPubkeys];
};

const getProfiles = async (fetcher: NostrFetcher, relays: string[], pubkeys: string[], profiles: Map<string, object>) => {
	const ev0PerAuthor = fetcher.fetchLastEventPerAuthor(
		{
			authors: pubkeys,
			relayUrls: relays
		},
		{ kinds: [0] },
	);
	for await (const { author, event } of ev0PerAuthor ) {
		if (event === undefined) {
			continue;
		}
		let profile;
		try {
			profile = JSON.parse(event.content);
		} catch (error) {
			console.warn(error);
			continue;
		}
		profiles.set(author, profile);
	}
	return profiles;
};

$: sortedEvents = sort === SortType.Time ? bookmarkedEvents
	: sort === SortType.Count ? bookmarkedEvents.toSorted((a, b) => {
		const count = (x: NostrEvent) => bookmarkedPubkeys.get(x.id)?.size ?? 0;
		if (count(a) < count(b)) {
			return 1;
		}
		if (count(a) > count(b)) {
			return -1;
		}
		return 0;
	}) : bookmarkedEvents;

</script>

<svelte:head>
	<title>Nostr Bookmark Trend</title>
</svelte:head>

<header><h1>Nostr Bookmark Trend</h1></header>
<main>
<button on:click={getNpubWithNIP07}>get public key from extension</button>
<input id="npub" type="text" placeholder="npub1..." bind:value={npub} />
<button on:click={getBookmarks} disabled={!npub || isGettingEvents}>show bookmarks of followees</button>
<span>Sort</span>
<label>
	<input type="radio" bind:group={sort} name="sorttype" value={SortType.Time}>
	time
</label>
<label>
	<input type="radio" bind:group={sort} name="sorttype" value={SortType.Count}>
	count
</label>
<p>{message}</p>
<dl>
	{#each sortedEvents as note}
		{@const count = bookmarkedPubkeys.get(note.id)?.size ?? 0}
		{#if count >= threshold}
			{@const pubkey = note.pubkey}
			{@const prof = profiles.get(pubkey)}
			{@const name = prof?.name ?? nip19.npubEncode(pubkey).slice(0, 10) + '...'}
			{@const display_name = prof?.display_name ?? ''}
			{@const picture = prof?.picture ?? getRoboHashURL(pubkey)}
			<dt><a href="{linkto}{nip19.npubEncode(pubkey)}" target="_blank" rel="noopener noreferrer"
				><img src="{picture}" alt="@{name}" title="{display_name} @{name}" class="avator_author" /> {display_name} @{name}</a
				> <a href="{linkto}{note.kind === 1 ? nip19.noteEncode(note.id) : nip19.neventEncode(note)}" target="_blank" rel="noopener noreferrer"
				><br /><time>{(new Date(1000 * note.created_at)).toLocaleString()}</time></a
				><span
			>{#each bookmarkedPubkeys.get(note.id) ?? [] as pubkey}
				{@const prof = profiles.get(pubkey)}
				{@const name = prof?.name ?? nip19.npubEncode(pubkey).slice(0, 10) + '...'}
				{@const display_name = prof?.display_name ?? ''}
				{@const picture = prof?.picture ?? getRoboHashURL(pubkey)}
				<a href="{linkto}{nip19.npubEncode(pubkey)}" target="_blank" rel="noopener noreferrer"
				><img src="{picture}" alt="@{name}" title="{display_name} @{name}" class="avator_bookmark" /></a>
			{/each}</span
			></dt>
			<dd>{note.content}</dd>
		{/if}
	{/each}
</dl>
</main>
<footer><a href={linkGitHub} target="_blank" rel="noopener noreferrer">GitHub</a></footer>

<style>
#npub {
	width: 100%;
}
img {
	border-radius: 10%;
}
.avator_author {
	width: 48px;
	height: 48px;
	float: left;
}
.avator_bookmark {
	width: 16px;
	height: 16px;
}
dd {
	clear: left;
	white-space: pre-wrap;
	margin-bottom: 1em;
}
footer {
	text-align: center;
}
</style>