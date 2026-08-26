# The tools of a proving run: how they are started, and how they are stopped.
#
# This is a file of its own so a test can drive it. The functions used to sit
# in the issuer script, which cannot be entered without the pinned toolchain, so
# every guarantee below rested on reading the source. A test now sources this
# file and drives the property with a tool of its own, which is what the client
# library did when the same guarantees moved out of its driver.
#
# A tool runs in the background and the caller waits for it. That is the
# mechanism rather than a preference. A tool in the foreground makes bash defer
# every trap until that tool finishes, so a signal that reaches the script alone
# would be handled minutes later, after the tool it was meant to stop had
# already finished. Waiting is what lets a handler run while a tool is running.
#
# Job control gives each background tool a process group of its own. That
# matters because `cargo run` starts the generator as a further process and the
# provers start work of their own, so a signal aimed at the tool alone leaves
# the process that actually writes the files. One signal to the group reaches
# the whole tree. Without job control a tool shares the caller's group, and the
# negated signal below then fails rather than reaching the caller's own group,
# so the group is load bearing rather than tidy.
#
# A group of its own also means an interrupt in a terminal no longer reaches a
# tool directly. That is the point. Before, an interrupt reached the tools
# because they shared the script's group, and the same interrupt from a service
# manager reached the script alone and left them running. Both cases now end the
# same way, because the script ends them itself.
#
# The stop asks bash which jobs it has rather than keeping a list of its own,
# and the reason is ownership. A signal aimed at an identifier that no longer
# names this run reaches whatever holds it now, and this signal cannot be
# caught, so it would end a group of processes belonging to somebody else on
# the machine.
#
# A list kept here has two edges that a list kept by bash does not. Between
# starting a tool and recording it, a stop finds nothing and the tool survives.
# Between `wait` returning and the record being cleared, a stop finds an
# identifier the operating system has already freed. Both are one command wide,
# and a trap runs between commands.
#
# The job table has neither edge. Bash "keeps a table of currently executing
# jobs", and "when a job terminates and bash notifies the user about it, bash
# removes the job from the table", which `wait` is what causes (JOB CONTROL in
# the bash manual, read against the shell this script runs under). Measured on
# that shell: a job appears in the table immediately after it is started, it
# stays there while it is a terminated child nobody has reaped, and it is gone
# once `wait` has returned. So a job in the table is a running tool of this run
# or a zombie of this run, and neither identifier can have been reassigned.
#
# `jobs -p` lists "the process ID of the job's process group leader", so each
# identifier it gives is a group and the negation below signals that group.
#
# The table holds every background job of the caller, not only its tools. Today
# those are the same set, because the one line that puts anything in the
# background is the one below. A line that later backgrounds a helper joins that
# set and the stop sends it the same uncatchable signal. That is a decision
# rather than an oversight: the guarantee is that nothing of this run outlives
# the stop, and a helper is part of the run.

# Starts one tool, waits for it, and gives back the status it ended with.
run_tool() {
  set -m
  "$@" &
  tool_pid=$!
  set +m
  tool_status=0
  wait "$tool_pid" || tool_status=$?
  return "$tool_status"
}

# Waits for each group to go, and names the ones that outlive the deadline.
#
# The value is what the caller states. A deadline that expires quietly leaves a
# reader believing the tools are gone, and the sweep that follows then runs
# against something that has not finished ending.
wait_for_groups() {
  still_alive=""
  for group in $1; do
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "-$group" 2>/dev/null || break
      sleep 0.05
    done
    if kill -0 "-$group" 2>/dev/null; then
      still_alive="$still_alive $group"
    fi
  done
  printf '%s' "${still_alive# }"
}

# Stops every tool of this run with a signal that cannot be caught, waits for
# the groups to go, and says so when one does not.
#
# The sweep runs after this and never before: a sweep that ran first would
# remove files a surviving tool then writes again, and nothing would remove them
# after that.
stop_tools() {
  running_groups=$(jobs -p)
  for group in $running_groups; do
    kill -KILL "-$group" 2>/dev/null
  done
  still_running=$(wait_for_groups "$running_groups")
  if [ -n "$still_running" ]; then
    echo "attest: these process groups had not ended when the stop gave up:$still_running" >&2
  fi
  return 0
}
