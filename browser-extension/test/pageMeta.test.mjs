import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadContentHelpers } from './loadContentHelpers.mjs'

const { extractPageMetadata } = loadContentHelpers()

function el(attrs = {}, text = '') {
  return {
    textContent: text,
    getAttribute(name) {
      return Object.hasOwn(attrs, name) ? attrs[name] : null
    }
  }
}

// Minimal fake document: routes exact selector strings to canned elements.
function doc({ scripts = [], metas = {}, author = null, imageSrc = null, title = null } = {}) {
  return {
    querySelectorAll(sel) {
      if (sel === 'script[type="application/ld+json"]') return scripts
      const prop = sel.match(/^meta\[property="([^"]+)"\]$/)
      if (prop) return metas[prop[1]] === undefined ? [] : [el({ content: metas[prop[1]] })]
      if (sel === 'meta[name="author"]') return author === null ? [] : [el({ content: author })]
      if (sel === 'link[rel="image_src"]') return imageSrc === null ? [] : [el({ href: imageSrc })]
      if (sel === 'title') return title === null ? [] : [el({}, title)]
      return []
    }
  }
}

const script = (obj) => el({}, typeof obj === 'string' ? obj : JSON.stringify(obj))

describe('extractPageMetadata', () => {
  it('reads a single JSON-LD MusicRecording object', () => {
    const d = doc({
      scripts: [
        script({
          '@context': 'https://schema.org',
          '@type': 'MusicRecording',
          name: 'Midnight Run',
          byArtist: { '@type': 'MusicGroup', name: 'The Runners' },
          inAlbum: { '@type': 'MusicAlbum', name: 'Night Tapes' },
          datePublished: '2021-05-01',
          trackNumber: 4,
          thumbnailUrl: 'https://cdn.example.com/cover.jpg'
        })
      ]
    })
    const meta = extractPageMetadata(d, 'https://example.com/track')
    assert.equal(meta.title, 'Midnight Run')
    assert.equal(meta.artist, 'The Runners')
    assert.equal(meta.album, 'Night Tapes')
    assert.equal(meta.year, 2021)
    assert.equal(meta.track, 4)
    assert.equal(meta.pageImage, 'https://cdn.example.com/cover.jpg')
  })

  it('flattens JSON-LD arrays and @graph', () => {
    const d = doc({
      scripts: [
        script([
          { '@type': 'MusicRecording', name: 'Array Song', byArtist: 'Array Band' },
          { '@type': 'WebPage', name: 'Not music' }
        ]),
        script({ '@graph': [{ '@type': 'AudioObject', name: 'Graph Song', trackNumber: '3/12' }] })
      ]
    })
    const meta = extractPageMetadata(d, 'https://example.com/x')
    assert.equal(meta.title, 'Array Song')
    assert.equal(meta.artist, 'Array Band')
    assert.equal(meta.track, 3)
  })

  it('handles byArtist as string, object and array', () => {
    assert.equal(extractPageMetadata(doc({ scripts: [script({ '@type': 'MusicRecording', byArtist: 'Solo' })] }), 'https://e.com/').artist, 'Solo')
    assert.equal(extractPageMetadata(doc({ scripts: [script({ '@type': 'MusicRecording', byArtist: { name: 'Obj Band' } })] }), 'https://e.com/').artist, 'Obj Band')
    assert.equal(
      extractPageMetadata(doc({ scripts: [script({ '@type': 'MusicRecording', byArtist: [{ name: 'First' }, { name: 'Second' }] })] }), 'https://e.com/').artist,
      'First'
    )
  })

  it('handles inAlbum as string and object', () => {
    assert.equal(extractPageMetadata(doc({ scripts: [script({ '@type': 'MusicRecording', inAlbum: 'String Album' })] }), 'https://e.com/').album, 'String Album')
    assert.equal(
      extractPageMetadata(doc({ scripts: [script({ '@type': 'MusicRecording', inAlbum: { name: 'Obj Album' }, albumName: 'Ignored' })] }), 'https://e.com/').album,
      'Obj Album'
    )
    assert.equal(extractPageMetadata(doc({ scripts: [script({ '@type': 'MusicRecording', albumName: 'Named Album' })] }), 'https://e.com/').album, 'Named Album')
  })

  it('parses trackNumber as "3/12" and as a number', () => {
    assert.equal(extractPageMetadata(doc({ scripts: [script({ '@type': 'MusicRecording', trackNumber: '3/12' })] }), 'https://e.com/').track, 3)
    assert.equal(extractPageMetadata(doc({ scripts: [script({ '@type': 'MusicRecording', trackNumber: 7 })] }), 'https://e.com/').track, 7)
  })

  it('uses OpenGraph when there is no JSON-LD', () => {
    const d = doc({ metas: { 'og:title': 'OG Song', 'og:image': 'https://e.com/og.jpg' } })
    const meta = extractPageMetadata(d, 'https://e.com/page')
    assert.equal(meta.title, 'OG Song')
    assert.equal(meta.pageImage, 'https://e.com/og.jpg')
  })

  it('falls back to author, image_src and <title>', () => {
    const d = doc({ author: 'Meta Author', imageSrc: 'https://e.com/i.png', title: 'Plain Title' })
    const meta = extractPageMetadata(d, 'https://e.com/page')
    assert.equal(meta.artist, 'Meta Author')
    assert.equal(meta.pageImage, 'https://e.com/i.png')
    assert.equal(meta.title, 'Plain Title')
  })

  it('strips entities and collapses whitespace', () => {
    const d = doc({ title: '  Fish &amp; Chips &#39;Live&#39;\n\tVersion  ' })
    assert.equal(extractPageMetadata(d, 'https://e.com/').title, "Fish & Chips 'Live' Version")
  })

  it('caps every field at 512 chars', () => {
    const long = 'x'.repeat(900)
    const d = doc({
      scripts: [script({ '@type': 'MusicRecording', name: long, byArtist: long, inAlbum: long, thumbnailUrl: `https://e.com/${long}.jpg` })]
    })
    const meta = extractPageMetadata(d, 'https://e.com/')
    for (const value of [meta.title, meta.artist, meta.album, meta.pageImage]) {
      assert.ok(typeof value === 'string' && value.length <= 512)
    }
  })

  it('skips malformed JSON-LD instead of throwing', () => {
    const d = doc({ scripts: [el({}, '{not json'), script({ '@type': 'MusicRecording', name: 'After Bad Block' })] })
    assert.equal(extractPageMetadata(d, 'https://e.com/').title, 'After Bad Block')
  })

  it('splits "Artist - Title.mp3" and keeps bare filenames as title', () => {
    const split = extractPageMetadata(doc(), 'https://cdn.example.com/files/Artist%20Name%20-%20Track%20One.mp3?dl=1#frag')
    assert.equal(split.artist, 'Artist Name')
    assert.equal(split.title, 'Track One')
    const bare = extractPageMetadata(doc(), 'https://cdn.example.com/files/justasong.ogg')
    assert.equal(bare.title, 'justasong')
    assert.equal(bare.artist, undefined)
  })

  it('never returns null and resolves relative page images', () => {
    const meta = extractPageMetadata(doc({ metas: { 'og:image': '/covers/a.jpg' } }), 'https://e.com/album/page')
    assert.equal(meta.pageImage, 'https://e.com/covers/a.jpg')
    assert.equal(meta.albumArtist, undefined)
    for (const value of Object.values(meta)) {
      assert.ok(value === undefined || typeof value === 'string' || typeof value === 'number')
    }
  })

  it('reads year from dateCreated and albumArtist from MusicAlbum', () => {
    const meta = extractPageMetadata(
      doc({ scripts: [script({ '@type': 'MusicAlbum', name: 'The Album', byArtist: 'Album Band', dateCreated: '2019' })] }),
      'https://e.com/'
    )
    assert.equal(meta.year, 2019)
    assert.equal(meta.albumArtist, 'Album Band')
  })
})
