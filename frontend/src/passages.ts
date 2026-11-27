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
  /**
   * Shown wherever the text is: Comma Gets a Cure's license requires its
   * permission sentence and copyright notice to accompany the passage.
   */
  notice?: string
}

export const BUILTIN_PASSAGES: Passage[] = [
  {
    id: 'builtin:comma-gets-a-cure',
    title: 'Comma Gets a Cure',
    source:
      'By Jill McCullough & Barbara Somerville, edited by Douglas N. Honorof; from the International Dialects of English Archive (dialectsarchive.com).',
    notice:
      'Comma Gets a Cure and derivative works may be used freely for any purpose without special permission provided the present sentence and the following copyright notification accompany the passage in print (if reproduced in print) and in audio format in the case of a sound recording: Copyright 2000 Douglas N. Honorof, Jill McCullough & Barbara Somerville.',
    text: `Well, here’s a story for you: Sarah Perry was a veterinary nurse who had been working daily at an old zoo in a deserted district of the territory, so she was very happy to start a new job at a superb private practice in North Square near the Duke Street Tower. That area was much nearer for her and more to her liking. Even so, on her first morning, she felt stressed. She ate a bowl of porridge, checked herself in the mirror and washed her face in a hurry. Then she put on a plain yellow dress and a fleece jacket, picked up her kit and headed for work.

When she got there, there was a woman with a goose waiting for her. The woman gave Sarah an official letter from the vet. The letter implied that the animal could be suffering from a rare form of foot and mouth disease, which was surprising, because normally you would only expect to see it in a dog or a goat. Sarah was sentimental, so this made her feel sorry for the beautiful bird.

Before long, that itchy goose began to strut around the office like a lunatic, which made an unsanitary mess. The goose’s owner, Mary Harrison, kept calling, “Comma, Comma,” which Sarah thought was an odd choice for a name. Comma was strong and huge, so it would take some force to trap her, but Sarah had a different idea. First she tried gently stroking the goose’s lower back with her palm, then singing a tune to her. Finally, she administered ether. Her efforts were not futile. In no time, the goose began to tire, so Sarah was able to hold on to Comma and give her a relaxing bath.

Once Sarah had managed to bathe the goose, she wiped her off with a cloth and laid her on her right side. Then Sarah confirmed the vet’s diagnosis. Almost immediately, she remembered an effective treatment that required her to measure out a lot of medicine. Sarah warned that this course of treatment might be expensive – either five or six times the cost of penicillin. I can’t imagine paying so much, but Mrs. Harrison – a millionaire lawyer – thought it was a fair price for a cure.`,
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
