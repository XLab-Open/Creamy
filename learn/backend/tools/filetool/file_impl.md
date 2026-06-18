# `backend/tools/filetool/file_impl.py` 精读(C 档·极详)

## 这个文件在干嘛

**生成带格式的库存 Excel**。`expansion_write_excel` 把库存查询结果(list[dict])写成一个排版好的
`.xlsx`(表头配色、缺货行标红、自动列宽)。`toolimpl.query.inventory` 工具用它产出 `inventory_*.xlsx`,
随后 `send.report` 把该文件发到飞书。

> 纯工具函数,无状态;业务相关(库存盘点报表)。用 openpyxl 库。

---

## 逐行精读

> **整块作用**:建工作簿、写表头(深蓝底白字)、逐行写数据(按状态着色)、自动列宽、保存。出错返回错误文本。

```python
import os
from datetime import datetime
import openpyxl                                   # Excel 读写库
from openpyxl.styles import Alignment, Font, PatternFill  # 单元格样式


def expansion_write_excel(data: list, output_path: str) -> str:
    """Generate an Excel table with formatting"""
    try:
        os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else ".", exist_ok=True)
        #   确保输出目录存在(无目录部分则用当前目录)。

        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "零件库存盘点"
        #   新建工作簿,取活动表并命名。

        headers = ["零件名称", "规格", "品牌", "材质", "当前库存", "状态", "最后更新时间"]
        #   表头列。
        header_fill = PatternFill(start_color="1F4E79", end_color="1F4E79", fill_type="solid")
        #   表头底色:深蓝。
        header_font = Font(color="FFFFFF", bold=True)
        #   表头字体:白色加粗。

        for col, header in enumerate(headers, 1):
            cell = ws.cell(row=1, column=col, value=header)
            cell.fill = header_fill
            cell.font = header_font
            cell.alignment = Alignment(horizontal="center")
            #   写每个表头单元格并套样式(居中)。

        fill_normal = PatternFill(start_color="E8F5E9", end_color="E8F5E9", fill_type="solid")    # 正常:浅绿
        fill_warning = PatternFill(start_color="FFF9C4", end_color="FFF9C4", fill_type="solid")   # 不足:浅黄
        fill_critical = PatternFill(start_color="FFEBEE", end_color="FFEBEE", fill_type="solid")  # 缺货:浅红

        updated_at = datetime.now().strftime("%Y-%m-%d %H:%M")
        #   统一的"最后更新时间"。
        for row_idx, item in enumerate(data, 2):
            #   数据从第 2 行开始(第 1 行是表头)。
            total = item.get("total", 0)
            status = "缺货" if total == 0 else "正常"
            #   库存为 0 标"缺货",否则"正常"。

            ws.cell(row=row_idx, column=1, value=item.get("name", ""))      # 名称
            ws.cell(row=row_idx, column=2, value=item.get("spec", ""))      # 规格
            ws.cell(row=row_idx, column=3, value=item.get("brand", ""))     # 品牌
            ws.cell(row=row_idx, column=4, value=item.get("material", ""))  # 材质
            ws.cell(row=row_idx, column=5, value=total)                     # 库存
            ws.cell(row=row_idx, column=6, value=status)                    # 状态
            ws.cell(row=row_idx, column=7, value=updated_at)                # 更新时间

            if "缺货" in status:
                row_fill = fill_critical    # 缺货 → 红
            elif "不足" in status:
                row_fill = fill_warning     # 不足 → 黄(当前 status 只有"缺货/正常",此分支预留)
            else:
                row_fill = fill_normal      # 正常 → 绿

            for col in range(1, len(headers) + 1):
                ws.cell(row=row_idx, column=col).fill = row_fill
                #   整行套底色。

        for col in ws.columns:
            max_len = max(len(str(cell.value or "")) for cell in col)
            ws.column_dimensions[col[0].column_letter].width = max_len + 4
            #   自动列宽 = 该列最长内容长度 + 4(留余量)。

        wb.save(output_path)
        #   保存文件。
        return f"Excel 已生成：{output_path}，共 {len(data)} 条记录"

    except Exception as e:
        return f"Excel 生成失败：{e!s}"
        #   出错返回错误文本(不抛,工具调用方据返回判断)。
```

---

## 怎么和别的文件连起来

- `tools/toolimpl.py`:`query.inventory` 调它写 Excel,`send.report` 发该文件。
- `inventory/inventory_query.py`:提供 `data`(库存查询结果)。

---

## 一句话总结

`file_impl.py` 用 openpyxl 把库存结果生成带配色(表头深蓝、缺货标红)、自动列宽的 Excel,供库存盘点
报表工具产出与发送。
