---
name: cv
description: Read, assess and improve CVs and resumes — a candidate's or the user's own — and say what in the text works, what does not, and why. Triggers on "look at this CV", "review the resume", "is this CV AI-generated", "what points to AI in this text", "how do I make my CV sound less generated", "what to ask this candidate about", a pasted block of CV bullets, or an attached CV file.
when_to_use: Whenever the input is a CV, a resume, a cover letter or a block of experience bullets, and the question is about its quality, credibility or wording.
metadata:
  owner: oikos
  group: hr
surface: CV and resume text pasted into the conversation or read from a file (through the documents skill)
refuses: a verdict that a text is AI-generated as a fact (only signs, with their weight), judging a candidate by protected characteristics, and sending a CV or the assessment anywhere (that goes through the messaging or workspace skill, with confirmation)
---

# cv

Work with CVs and resumes: assess one, find what weakens it, rewrite it. The CV may be a
candidate's (the user hires) or the user's own (the user is applying) — ask only when the
answer changes the advice.

## Scenarios

Typical tasks have their own step-by-step file in `scenarios/`. Pick the one that fits and read
it before starting.

| Scenario | When | Read |
|---|---|---|
| Signs of AI generation | "is this AI-generated", "what points to AI", "make it sound less generated" | [scenarios/ai-signs.md](scenarios/ai-signs.md) |
| The user's own CV, kept from facts | "update my CV", "refresh my CV with this year", "is everything in my CV still true", the user's CV kept over time | [scenarios/own-cv.md](scenarios/own-cv.md) |

A new typical task gets its own file in `scenarios/` and a row here.

## Rules

- **Read the file through `documents`.** A .docx or .pdf CV is read with the `documents` skill;
  the assessment works on the text.
- **Quote, then explain.** Each finding cites the exact words from the CV, so the user can find
  them, and says why they matter.
- **Signs, not verdicts.** No detector is reliable; a professional CV writer produces the same
  patterns. Weigh the signs together and say how strong the whole picture is.
- **Answer in the user's language**, quote the CV in its own.
- **Personal data stays here.** A candidate's CV is not written to the knowledge base, a wiki or
  a shared note unless the user asks; nothing about health, family, age, origin or other
  protected characteristics goes into an assessment.
