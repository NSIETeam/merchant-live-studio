import type { PresenterProfile } from "../shared/agent.js";
export function PresenterEditor({
  value,
  onChange,
}: {
  value?: PresenterProfile;
  onChange: (value: PresenterProfile | undefined) => void;
}) {
  function update(change: Partial<PresenterProfile>) {
    if (value) onChange({ ...value, authorizationConfirmed: false, ...change });
  }
  return (
    <details>
      <summary>真人主播档案 · {value?.displayName || "通用表达"}</summary>
      <p>
        档案随提示词版本保存，短句试演与长稿任务使用相同快照。仅组织文字表达，不克隆声音，也不把主播经历当成商品依据。
      </p>
      <label>
        <input
          type="checkbox"
          checked={!!value}
          onChange={(e) => {
            if (e.target.checked) {
              onChange({
                displayName: "",
                roleDescription: "",
                speakingStyle: "",
                pace: "balanced",
                authorizationReference: "",
                authorizationConfirmed: false,
              });
            } else onChange(undefined);
          }}
        />
        为此方案绑定获授权的真人主播
      </label>
      {value && (
        <>
          <label>
            主播展示名
            <input
              maxLength={80}
              value={value.displayName}
              onChange={(e) => update({ displayName: e.target.value })}
            />
          </label>
          <label>
            工作角色说明
            <textarea
              rows={2}
              maxLength={400}
              value={value.roleDescription}
              onChange={(e) => update({ roleDescription: e.target.value })}
              placeholder="例如：门店讲解员。不得填写未经核实的专家资格。"
            />
          </label>
          <label>
            表达特点
            <textarea
              rows={3}
              maxLength={1200}
              value={value.speakingStyle}
              onChange={(e) => update({ speakingStyle: e.target.value })}
              placeholder="例如：短句、语气温和、先解释再举例；只填写获授权的表达特点。"
            />
          </label>
          <label>
            表达节奏
            <select
              value={value.pace}
              onChange={(e) =>
                update({ pace: e.target.value as PresenterProfile["pace"] })
              }
            >
              <option value="slow">舒缓</option>
              <option value="balanced">适中</option>
              <option value="brisk">明快</option>
            </select>
          </label>
          <label>
            授权依据
            <textarea
              rows={2}
              maxLength={500}
              value={value.authorizationReference}
              onChange={(e) => {
                update({
                  authorizationReference: e.target.value,
                  authorizationConfirmed: false,
                });
              }}
              placeholder="填写获授权的材料编号、授权范围与核对日期；不要粘贴证件或联系方式。"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={value.authorizationConfirmed === true}
              onChange={(e) => {
                update({ authorizationConfirmed: e.target.checked });
              }}
            />
            已核对本人授权，允许将表达特点用于本商家的文本辅助生成
          </label>
          <p>
            授权由商家核对，系统不自动验证合同。姓名、工作说明和授权依据仅留在内部档案；模型仅收到表达特点与节奏。未确认授权不能保存带主播档案的版本。
          </p>
        </>
      )}
    </details>
  );
}
