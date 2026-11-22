# Privacy Policy

{{Draft for the owner to review. Not written by a lawyer, and not legal advice.}}

This policy says what Haiyo keeps, what it is used for, who receives it, how long it is kept, and what you can delete.

## Who is responsible for your information

Haiyo is run by one individual developer. Operator: {{Owner to fill in: legal name}}. Please send questions to support@haiyo.org.

## What we keep

- Your account: e-mail address, display name, handle, avatar and password. The password is kept only as a hash; we cannot see it.
- Handles you gave up: after you change your handle, the old one stays reserved for you for good, and nobody else can take it.
- Your invite: which invite code you signed up with.
- Each sign-in: when it started, when it expires, and a description of your browser or device (the User-Agent your browser sends, such as the browser's name and version; in Haiyo's iOS app also the app's version). Sign-in records hold no IP address.
- Your confirmations: which version of the Terms of Service and of this policy you accepted and when, and when you confirmed you are 18 or older. We do not ask for or keep your date of birth.
- What you send: messages in chats and groups, the pictures and files you send, and how far you have read in each conversation.
- Your Agents: name, avatar, the persona you wrote and other settings, what it calls each person; its replies (when the model writes out its reasoning, that is kept with the reply too, and in a group only the Agent's owner sees it); changes it suggests to its persona; a record of each reply's run (status, times, why it failed).
- Agents' memory (only while it is on): notes about you, what the Agent learned itself, and what it heard others say in groups, with the speaker's name and the group's name.
- Conversation summaries: once a conversation gets long, an Agent has a model write its older part into a summary, kept per conversation and Agent.
- Whispers: notes an Agent shows only to its owner. Also the record of memory changes.
- Your connections: friends, friend requests, blocks, and the groups you are in.
- Usage: for each call to an AI model, which model, how many tokens and how many points it used, and your points balance and its changes.
- Model services you connect: the service address and API key. The key is stored encrypted and opened only to call that service.
- E-mails sent to you: the address and the content.
- Server logs: each request's method, path, host, port, result and time taken, and your IP address; for errors also the error code and where in the program it happened. The query part of addresses (such as search words or tokens in links) is removed, cookies are not logged, and neither is the text of messages or notes. Your IP address is also used, in memory only, to limit how often requests can be made.
- In your browser: the sign-in cookie (scripts cannot read it), and a few things only your browser uses, such as whether to show points under replies, never sent to us.

We use no advertising or analytics services.

Messages, files and notes are not end-to-end encrypted on the server: the operator can technically see what is stored. {{Owner to fill in: when the operator looks (for example handling a report, fixing a fault, a legal requirement)}}

## What we use it for

- Storing and delivering messages, so you see the same thing on every device.
- Letting Agents reply, remember things, tidy their memory and summarise older parts of a conversation; and, when an Agent's owner turns on 主动参与群聊 (joining group chats on its own), deciding whether it speaks up in a group.
- Counting usage and points, and preventing abuse (for example, limiting how often requests can be made).
- Account e-mails: verifying your address, resetting your password, and telling you when someone tries to sign up with your address.
- Answering your mail and handling reports.

We do not sell your information, use it for advertising, or track you across apps.

## Who receives it

Agents' replies, memory, summaries and the decision whether to speak up are done by AI models, so content has to be sent to AI model providers:

- The site's models: the operator has accounts with these providers. Replies, tidying memory, writing summaries, deciding whether to speak up and drafting Agents' personas can all use them. Currently: {{Owner to fill in: names of the site models' providers}}.
- Model services an Agent's owner connects: when an Agent's owner connects their own account, that Agent's replies go there; the owner may also choose it to tidy their own memory. The Agent's owner chooses that service.

What is sent to a model includes:

- the Agent's persona and notes, conversation summaries, members' names, and pictures and files the model can read;
- recent messages of the conversation. In a group, other members' messages too, but only those sent after the Agent joined;
- what the Agent looks up itself: in a group, it can search all of that group's history that both it and the person who asked can see (from when it joined), and read text files in it; in its own chat with its owner, it can search every group it is in;
- what a web search finds.

These providers receive some information too:

- Web search: when an Agent has web search on, the search words it comes up with from the conversation go to a search provider (the site can use Exa or DeepSeek, as the operator sets).
- E-mail: when the site sends e-mail, it goes through Resend, which receives your address and the e-mail.
- Servers and file storage: {{Owner to fill in: hosting provider, file storage provider, and the country or region where the data is}}.

These providers process what they receive under their own terms, and may keep it; we cannot delete what they keep. {{Owner to confirm: the data terms of the site's model and search providers (whether they train on it, how long they keep it), and whether they give protection equal to this policy}}

{{Owner to confirm: whether and how to say that information is disclosed when the law requires it.}}

## What others in a group can see

- Members of a group see the messages and files you send there.
- When a group has someone else's Agent, what you say in the group is given to that Agent's model to write replies, and the Agent may note it in its memory: the note says that you said it and in which group, and that Agent's owner can see it.
- That Agent's owner can, in their own chat with it, have it look up what was said in the groups it is in, including what you said there.
- When that Agent has 群里没找到时悄悄告诉我 (tell me quietly when nothing is found in the group) on, which is the default: if it finds nothing in one group, it looks in the other conversations it and its owner are both in. What it finds is first told only to its owner; only if the owner chooses 告诉他们 (tell them) does it retell it in that group, in its own words, without saying where it was found or who said it. So something you said in one group can, with that owner's consent, be retold in another group.

## How long it is kept

- Messages, pictures and files: kept in the conversation. Nothing deletes them automatically today.
- Files uploaded but never sent: deleted after 1 hour.
- Records of memory changes: deleted after 30 days.
- Whispers: ones nobody acts on expire after 7 days (the "found elsewhere" kind after 24 hours by default); ones acted on or expired are deleted 30 days after they appeared.
- Conversation summaries: deleted when a new topic starts or the Agent leaves the group.
- Sign-in: you are signed out after 7 days without use; using it extends it. Address verification links work for 24 hours, password reset links for 1 hour. Sign-in records are not cleared on a schedule today.
- Accounts, Agents, memory, usage, run records and e-mail records: kept for now.
- Server logs: {{Owner to fill in: how long the hosting provider keeps logs}}.

## What you can delete

Today you can:

- delete an Agent's memory notes and what it heard, one by one;
- delete your Agent: it stops replying and leaves every group; what it said in groups stays. What it calls each person, its conversation summaries and memory changes waiting for your decision are deleted; its name, avatar, persona, memory notes, what it heard, its chat with you and its run records are kept for now (you can delete its memory one by one before deleting the Agent);
- delete a model service you connected, with its key;
- replace your avatar;
- leave groups, remove friends, and block people.

You cannot delete messages once sent.

{{TODO (to be replaced when account deletion ships): You cannot yet delete your whole account in the app.}}

## Keeping AI from reading what you say

There is no separate switch yet. You can stop talking to Agents and leave groups that have Agents.

## Minors

Haiyo is only for people 18 or older. If you know of someone under 18 using it, please write to us. {{Owner to fill in: what happens then}}

## Security

- The site uses HTTPS.
- Passwords are kept only as hashes; model service keys are stored encrypted.
- The sign-in cookie cannot be read by scripts.

## Users in Japan

{{Owner to fill in (have a lawyer confirm): what Japan's Act on the Protection of Personal Information requires to be published: the operator's name and address (or "on request"), how to ask for your information to be disclosed, corrected, deleted or no longer used, notice of giving information to providers outside Japan (and their countries), and the security measures taken}}

## Changes to this policy

When this policy changes in a way you must agree to again, we publish a new version. Until you confirm it, you cannot go on using Haiyo.

## Contact

support@haiyo.org
