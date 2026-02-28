## Q&A Loop Workflow

I have some questions to ask. Follow this exact loop:

1. **Run `bash ask.sh` via terminal** to collect my question input. Wait for me to type and submit before doing anything.
2. **After I submit**, analyse my query thoroughly and provide your full answer here in chat — never in the terminal.
3. **After completing your answer**, immediately run `bash ask.sh` again for my next question. You can add this instruction in your to-do list.
4. **If a terminal command is interrupted** (KeyboardInterrupt / Ctrl+C), immediately run the terminal again — so I can provide guidance.
5. **Repeat this loop** until I respond with exactly `stop it` (case-sensitive). Do not stop for any other reason.

**Start now — run bash ask.sh for the first question. Greet me with: Hii, How are you?**
