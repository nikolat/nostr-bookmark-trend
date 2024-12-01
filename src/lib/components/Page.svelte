<script lang="ts">
	import { NostrFetcher, type NostrEventWithAuthor } from 'nostr-fetch';
	import type { NostrEvent } from 'nostr-tools/pure';
	import type { RelayRecord } from 'nostr-tools/relay';
	import { insertEventIntoDescendingList, normalizeURL } from 'nostr-tools/utils';
	import * as nip19 from 'nostr-tools/nip19';
	import { defaultRelays, getRoboHashURL, linkGitHub, linkto, threshold } from '$lib/config';
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';

	type Profile = {
		name: string;
		display_name: string;
		picture: string;
	};
	type SortType = 'Time' | 'Count';
	let npub: string = $state('');
	let bookmarkedEvents: NostrEvent[] = $state([]);
	let bookmarkedPubkeys = $state(new SvelteMap<string, SvelteSet<string>>());
	let profiles = $state(new SvelteMap<string, Profile>());
	let isGettingEvents = $state(false);
	let message = $state('');
	let sort: SortType = $state('Time');

	const getNpubWithNIP07 = async () => {
		const nostr = window.nostr;
		if (nostr?.getPublicKey) {
			let _pubkey: string;
			try {
				_pubkey = await nostr.getPublicKey();
			} catch (error) {
				console.error(error);
				return;
			}
			//await setNpubAndRelays(_pubkey);
			//=> nostr-login
		}
	};

	const setNpubAndRelays = async (pubkey: string) => {
		npub = nip19.npubEncode(pubkey);
		const nostr = window.nostr;
		if (nostr?.getRelays) {
			let rr: RelayRecord;
			try {
				rr = await nostr.getRelays();
			} catch (error) {
				console.error(error);
				return;
			}
			const relays: string[] = [];
			for (const [k, v] of Object.entries(rr)) {
				if (v.read) relays.push(normalizeURL(k));
			}
			if (relays.length > 0) {
				npub = nip19.nprofileEncode({ pubkey, relays });
			}
		}
	};

	const getBookmarks = async () => {
		bookmarkedPubkeys.clear();
		let dr;
		try {
			dr = nip19.decode(npub);
		} catch (error) {
			console.error(error);
			return;
		}
		let pubkey: string;
		let relaySet = new Set<string>(defaultRelays);
		if (dr.type === 'npub') {
			pubkey = dr.data;
		} else if (dr.type === 'nprofile') {
			pubkey = dr.data.pubkey;
			if (dr.data.relays !== undefined) {
				for (const relay of dr.data.relays) relaySet.add(normalizeURL(relay));
			}
		} else {
			console.error(`${npub} is not npub/nprofile`);
			return;
		}
		const targetPubkey = pubkey;
		isGettingEvents = true;
		message = 'getting bookmarks...';
		const fetcher = NostrFetcher.init();
		const ev10002: NostrEvent | undefined = await fetcher.fetchLastEvent(Array.from(relaySet), {
			kinds: [10002],
			authors: [targetPubkey]
		});
		if (ev10002 !== undefined) {
			for (const tag of ev10002.tags.filter(
				(tag) => tag.length >= 2 && tag[0] === 'r' && URL.canParse(tag[1])
			)) {
				if (tag.length === 2 || tag[2] === 'read') {
					relaySet.add(normalizeURL(tag[1]));
				}
			}
		}
		const relays = Array.from(relaySet);
		console.log('relays:', relays);
		message = `${relays.length} relays`;
		const ev3: NostrEvent | undefined = await fetcher.fetchLastEvent(relays, {
			kinds: [3],
			authors: [targetPubkey]
		});
		if (ev3 === undefined) {
			console.warn('followees is 0');
			isGettingEvents = false;
			return;
		}
		const followingPubkeys = ev3.tags.filter((tag) => tag[0] === 'p').map((tag) => tag[1]);
		console.log('followees:', followingPubkeys);
		message = `${followingPubkeys.length} followees`;
		const ev10003PerAuthor = fetcher.fetchLastEventPerAuthor(
			{
				authors: followingPubkeys,
				relayUrls: relays
			},
			{ kinds: [10003] } //Bookmarks
		);
		const ev30001PerAuthor = fetcher.fetchLastEventPerAuthor(
			{
				authors: followingPubkeys,
				relayUrls: relays
			},
			{ kinds: [30001], '#d': ['bookmark'] } //Deprecated
		);
		const ev30003PerAuthor = fetcher.fetchLastEventPerAuthor(
			{
				authors: followingPubkeys,
				relayUrls: relays
			},
			{ kinds: [30003] } //Bookmark sets
		);
		let bookmarkNoteIds = new Set<string>();
		for (const itr of [ev10003PerAuthor, ev30001PerAuthor, ev30003PerAuthor]) {
			await setBookmarkedPubkeys(itr, bookmarkNoteIds, bookmarkedPubkeys);
		}
		const bookmarkNoteIdsTofetch = Array.from(bookmarkNoteIds).filter(
			(id) => (bookmarkedPubkeys.get(id)?.size ?? 0) >= threshold
		);
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
		profiles.clear();
		await setProfiles(fetcher, relays, Array.from(pubkeysToFetch), profiles);

		bookmarkedEvents = [];
		const inc = 50;
		const max = 1000;
		const until = Math.floor(Date.now() / 1000);
		console.log('fetch bookmark start');
		for (let i = 0; i < bookmarkNoteIdsTofetch.length && i < max; i += inc) {
			console.log(`${i} / ${bookmarkNoteIdsTofetch.length}`);
			message = `${i} / ${bookmarkNoteIdsTofetch.length} fetching events...`;
			const ids = bookmarkNoteIdsTofetch.slice(
				i,
				Math.min(i + inc, bookmarkNoteIdsTofetch.length - 1)
			);
			const postIter = fetcher.allEventsIterator(relays, { ids: ids }, { until: until });
			for await (const ev of postIter) {
				bookmarkedEvents = insertEventIntoDescendingList(bookmarkedEvents, ev);
			}
			const pubkeysOfBookmark = Array.from(
				new Set<string>(bookmarkedEvents.map((ev) => ev.pubkey))
			);
			const pubkeysGot = new Set<string>(profiles.keys());
			const diff = pubkeysOfBookmark.filter((p) => !pubkeysGot.has(p));
			if (diff.length > 0) {
				await setProfiles(fetcher, relays, diff, profiles);
			}
		}
		console.log('fetch bookmark end');
		isGettingEvents = false;
		message = 'complete';
	};

	const setBookmarkedPubkeys = async (
		itr: AsyncIterable<NostrEventWithAuthor<false>>,
		bookmarkNoteIds: Set<string>,
		bookmarkedPubkeys: SvelteMap<string, Set<string>>
	): Promise<void> => {
		for await (const { author, event } of itr) {
			if (event === undefined) {
				continue;
			}
			for (const id of event.tags
				.filter((tag) => tag.length >= 2 && tag[0] === 'e')
				.map((tag) => tag[1])) {
				bookmarkNoteIds.add(id);
				let v = bookmarkedPubkeys.get(id);
				if (v === undefined) {
					v = new Set<string>();
				}
				v.add(author);
				bookmarkedPubkeys.set(id, v);
			}
		}
	};

	const setProfiles = async (
		fetcher: NostrFetcher,
		relays: string[],
		pubkeys: string[],
		profiles: SvelteMap<string, Profile>
	): Promise<void> => {
		const ev0PerAuthor = fetcher.fetchLastEventPerAuthor(
			{
				authors: pubkeys,
				relayUrls: relays
			},
			{ kinds: [0] }
		);
		for await (const { author, event } of ev0PerAuthor) {
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
	};

	const sortedEvents = $derived(
		sort === 'Time'
			? bookmarkedEvents
			: sort === 'Count'
				? bookmarkedEvents.toSorted((a, b) => {
						const count = (x: NostrEvent) => bookmarkedPubkeys.get(x.id)?.size ?? 0;
						if (count(a) < count(b)) {
							return 1;
						}
						if (count(a) > count(b)) {
							return -1;
						}
						return 0;
					})
				: bookmarkedEvents
	);

	onMount(() => {
		document.addEventListener('nlAuth', (e) => {
			const ce: CustomEvent = e as CustomEvent;
			if (ce.detail.type === 'login' || ce.detail.type === 'signup') {
				setNpubAndRelays(ce.detail.pubkey);
			} else {
				npub = '';
			}
		});
	});
</script>

<svelte:head>
	<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/water.css@2/out/dark.css" />
	<script src="https://www.unpkg.com/nostr-login@latest/dist/unpkg.js"></script>
	<title>Nostr Bookmark Trend</title>
</svelte:head>

<header><h1>Nostr Bookmark Trend</h1></header>
<main>
	<button onclick={getNpubWithNIP07}>get public key from extension</button>
	<input id="npub" type="text" placeholder="npub1... or nprofile1..." bind:value={npub} />
	<button onclick={getBookmarks} disabled={!npub || isGettingEvents}
		>show bookmarks of followees</button
	>
	<span>Sort</span>
	<label>
		<input type="radio" bind:group={sort} name="sorttype" value={'Time'} />
		time
	</label>
	<label>
		<input type="radio" bind:group={sort} name="sorttype" value={'Count'} />
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
				<dt>
					<a href="{linkto}{nip19.npubEncode(pubkey)}" target="_blank" rel="noopener noreferrer"
						><img
							src={picture}
							alt="@{name}"
							title="{display_name} @{name}"
							class="avator_author"
						/>
						{display_name} @{name}</a
					>
					<a
						href="{linkto}{note.kind === 1
							? nip19.noteEncode(note.id)
							: nip19.neventEncode({ ...note, author: note.pubkey })}"
						target="_blank"
						rel="noopener noreferrer"
						><br /><time>{new Date(1000 * note.created_at).toLocaleString()}</time></a
					><span
						>{#each bookmarkedPubkeys.get(note.id) ?? [] as pubkey}
							{@const prof = profiles.get(pubkey)}
							{@const name = prof?.name ?? nip19.npubEncode(pubkey).slice(0, 10) + '...'}
							{@const display_name = prof?.display_name ?? ''}
							{@const picture = prof?.picture ?? getRoboHashURL(pubkey)}
							<a href="{linkto}{nip19.npubEncode(pubkey)}" target="_blank" rel="noopener noreferrer"
								><img
									src={picture}
									alt="@{name}"
									title="{display_name} @{name}"
									class="avator_bookmark"
								/></a
							>
						{/each}</span
					>
				</dt>
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
		max-height: 40em;
		overflow-y: auto;
	}
	footer {
		text-align: center;
	}
</style>
