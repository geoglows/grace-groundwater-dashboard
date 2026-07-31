from pathlib import Path

import xarray as xr
from natsort import natsorted
from zarr.codecs import Zstd

if __name__ == '__main__':
    root = Path('/Users/rchales/data/groundwater/gldas')
    zarrs = Path('/Users/rchales/data/groundwater/zarrs')

    gldas_noah_dir = root / 'GLDAS_NOAH025_M.2.1'
    gldas_vic_dir = root / 'GLDAS_VIC10_M.2.1'
    gldas_clsm_dir = root / 'GLDAS_CLSM10_M.2.1'

    assert gldas_noah_dir.exists(), f"{gldas_noah_dir} does not exist"
    assert gldas_vic_dir.exists(), f"{gldas_vic_dir} does not exist"
    assert gldas_clsm_dir.exists(), f"{gldas_clsm_dir} does not exist"

    gldas_noah_zarr = zarrs / f'{gldas_noah_dir.name}.zarr'
    gldas_vic_zarr = zarrs / f'{gldas_vic_dir.name}.zarr'
    gldas_clsm_zarr = zarrs / f'{gldas_clsm_dir.name}.zarr'

    base_vars = ["SWE_inst", "CanopInt_inst", ]
    gldas_noah_vars = ["SoilMoi0_10cm_inst", "SoilMoi10_40cm_inst", "SoilMoi40_100cm_inst", "SoilMoi100_200cm_inst", ]
    gldas_vic_vars = ["SoilMoi0_30cm_inst", "SoilMoi_depth2_inst", "SoilMoi_depth3_inst", ]
    gldasd_clsm_vars = ["SoilMoist_P_inst", ]

    for data_path, zarr_path, dataset_vars in zip(
            [gldas_noah_dir, gldas_vic_dir, gldas_clsm_dir],
            [gldas_noah_zarr, gldas_vic_zarr, gldas_clsm_zarr],
            [gldas_noah_vars, gldas_vic_vars, gldasd_clsm_vars]
    ):
        if zarr_path.exists():
            print(f"{zarr_path} already exists. Skipping...")
            continue
        (data_path / '..').mkdir(parents=True, exist_ok=True)
        ds = xr.open_mfdataset(natsorted(data_path.glob('*/GLDAS*.nc4')))[base_vars + dataset_vars]
        (
            ds
            .load()
            .chunk({
                'time': 240,
                'lat': 8,
                'lon': 8,
            })
            .to_zarr(
                zarr_path, mode='w', consolidated=False, zarr_format=3,
                encoding={var: {'compressors': Zstd(level=9)} for var in ds.data_vars}
            )
        )
