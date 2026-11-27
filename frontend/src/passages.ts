// Fixed passages: texts read the same way every time, so recordings of one
// can be compared over time and between friends. The built-in ones ship
// with the app; their sources and licenses are recorded in
// docs/mvp-local.md §8 (VB-349). Ids are stored in recordings, so never change one.

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
    id: 'builtin:rainbow',
    title: 'The Rainbow Passage',
    source: 'Grant Fairbanks, Voice and Articulation Drillbook (2nd ed., 1960); a standard voice-assessment passage. Text as in VoiceTrainer (github.com/petravanta/voicetrainer).',
    text: `When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors. These take the shape of a long round arch, with its path high above, and its two ends apparently beyond the horizon. There is, according to legend, a boiling pot of gold at one end. People look, but no one ever finds it. When a man looks for something beyond his reach, his friends say he is looking for the pot of gold at the end of the rainbow.

Throughout the centuries people have explained the rainbow in various ways. Some have accepted it as a miracle without physical explanation. To the Hebrews it was a token that there would be no more universal floods. The Greeks used to imagine that it was a sign from the gods to foretell war or heavy rain. The Norsemen considered the rainbow as a bridge over which the gods passed from earth to their home in the sky. Others have tried to explain the phenomenon physically. Aristotle thought that the rainbow was caused by reflection of the sun's rays by the rain. Since then physicists have found that it is not reflection, but refraction by the raindrops which causes the rainbows.`,
  },
  {
    id: 'builtin:grandfather',
    title: 'The Grandfather Passage',
    source: 'A standard speech-assessment passage, commonly attributed to Charles Van Riper (1963). Text as in VoiceTrainer (github.com/petravanta/voicetrainer).',
    text: `You wish to know all about my grandfather. Well, he is nearly ninety-three years old. He dresses himself in an ancient black frock coat, usually minus several buttons; yet he still thinks as swiftly as ever. A long, flowing beard clings to his chin, giving those who observe him a pronounced feeling of the utmost respect. When he speaks, his voice is just a bit cracked and quivers a trifle. Twice each day he plays skillfully and with zest upon our small organ. Except in the winter when the ooze or snow or ice prevents, he slowly takes a short walk in the open air each day. We have often urged him to walk more and smoke less, but he always answers, "Banana oil!" Grandfather likes to be modern in his language.`,
  },
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
