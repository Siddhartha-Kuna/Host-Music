#!/usr/bin/env python3
import sys
import json
import urllib.request
import urllib.parse

def clean_title(title):
    # Strip trailing "(Movie/Soundtrack Name)" style parentheticals often added by iTunes
    if '(' in title and title.rstrip().endswith(')'):
        base = title[:title.rfind('(')].strip()
        if base:
            return base
    return title

def main():
    query = sys.argv[1]
    params = urllib.parse.urlencode({
        'term': query,
        'media': 'music',
        'entity': 'song',
        'limit': 1
    })
    url = f"https://itunes.apple.com/search?{params}"

    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(json.dumps({"error": f"iTunes request failed: {e}"}))
        sys.exit(1)

    if data.get('resultCount', 0) == 0 or not data.get('results'):
        print(json.dumps({"error": "no match found"}))
        sys.exit(1)

    track = data['results'][0]
    artist = track.get('artistName', '').split(' & ')[0].split(' Featuring ')[0].strip()
    title = clean_title(track.get('trackName', ''))
    album = track.get('collectionName', '')
    year = None
    if track.get('releaseDate'):
        year = track['releaseDate'][:4]
    cover = track.get('artworkUrl100', '').replace('100x100bb', '600x600bb')

    print(json.dumps({
        "title": title,
        "artist": artist,
        "album": album,
        "year": year,
        "cover_url": cover,
        "track_number": track.get('trackNumber'),
    }))

if __name__ == "__main__":
    main()
