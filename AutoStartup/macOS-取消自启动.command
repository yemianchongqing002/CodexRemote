#!/bin/bash
startup_dir="$(cd "$(dirname "$0")" && pwd)"
/bin/bash "$startup_dir/manage-macos.sh" disable
result=$?
if [[ $result -ne 0 ]]; then printf '\n操作失败，请检查上面的错误信息。\n'; fi
printf '\n按回车关闭窗口……'
read -r answer
exit "$result"
