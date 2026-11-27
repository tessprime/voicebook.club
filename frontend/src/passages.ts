// Fixed passages: texts read the same way every time, so recordings of one
// can be compared over time and between friends. The built-in ones ship
// with the app; their licenses were checked for VB-349 (see
// docs/mvp-local.md §11). Ids are stored in recordings, so never change one.

export type Passage = {
  id: string
  title: string
  /** Paragraphs, separated by blank lines. */
  text: string
  /** Where the text comes from. */
  source: string
}

export const BUILTIN_PASSAGES: Passage[] = [
  {
    id: 'builtin:the-wind-and-the-sun',
    title: 'The Wind and the Sun',
    source: 'Aesop, in Joseph Jacobs’ translation, The Fables of Æsop (1894); public domain.',
    text: `The Wind and the Sun were disputing which was the stronger. Suddenly they saw a traveller coming down the road, and the Sun said: "I see a way to decide our dispute. Whichever of us can cause that traveller to take off his cloak shall be regarded as the stronger. You begin." So the Sun retired behind a cloud, and the Wind began to blow as hard as it could upon the traveller. But the harder he blew the more closely did the traveller wrap his cloak round him, till at last the Wind had to give up in despair. Then the Sun came out and shone in all his glory upon the traveller, who soon found it too hot to walk with his cloak on.

Kindness effects more than Severity.`,
  },
]

export function findPassage(id: string | null | undefined): Passage | undefined {
  return id ? BUILTIN_PASSAGES.find((p) => p.id === id) : undefined
}
