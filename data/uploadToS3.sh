#!/usr/bin/env bash

zarrs_root=$1
if [ -z "$zarrs_root" ]; then
    echo "Error: zarrs_root variable is empty"
    exit 1
fi
if [ ! -d "$zarrs_root" ]; then
    echo "Error: zarrs_root path does not exist or is not a directory"
    exit 1
fi

s5cmd --dry-run sync "${zarrs_root}/*.zarr" s3://apps-geoglows-static/ggg/
